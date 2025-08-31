const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Store connected drivers, hospitals and active SOS
let ambulanceDrivers = new Map();
let hospitals = new Map();
let activeSOS = new Map();

// ✅ Distance calculation (Haversine Formula)
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Serve main pages
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/register", (req, res) => res.sendFile(path.join(__dirname, "public", "registration.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "user-dashboard.html")));
app.get("/driver", (req, res) => res.sendFile(path.join(__dirname, "public", "ambulance-driver.html")));
app.get("/hospital", (req, res) => res.sendFile(path.join(__dirname, "public", "hospital-dashboard.html")));

// ✅ Socket.IO
io.on("connection", (socket) => {
  console.log(`New client connected: ${socket.id}`);

  // 🚗 Register ambulance driver
  socket.on("registerDriver", (driverData) => {
    ambulanceDrivers.set(socket.id, {
      ...driverData,
      socketId: socket.id,
      status: "available",
    });
    console.log(`Driver registered: ${driverData.name}`);

    socket.emit("driverRegistered", {
      message: "Successfully registered as ambulance driver",
      driverCount: ambulanceDrivers.size,
    });

    io.emit("driverCountUpdate", { count: ambulanceDrivers.size });
  });

  // 🏥 Register hospital
  socket.on("registerHospital", (hospitalData) => {
    let lat = null, lng = null;
    
    // Try to get location from hospitalLocation field first
    if (hospitalData.hospitalLocation && hospitalData.hospitalLocation.includes(",")) {
      [lat, lng] = hospitalData.hospitalLocation.split(",").map((c) => parseFloat(c.trim()));
    }
    // Fallback to separate lat/lng fields if available
    else if (hospitalData.lat && hospitalData.lng) {
      lat = parseFloat(hospitalData.lat);
      lng = parseFloat(hospitalData.lng);
    }

    hospitals.set(socket.id, {
      ...hospitalData,
      lat,
      lng,
      socketId: socket.id,
      connectedAt: new Date(),
    });
    console.log(`Hospital registered: ${hospitalData.name} at location: ${lat}, ${lng}`);

    const activeSOSList = Array.from(activeSOS.values());
    socket.emit("hospitalRegistered", {
      message: "Successfully registered as hospital",
      activeSOS: activeSOSList,
    });
  });

  // 📱 Handle SOS from patients
  socket.on("sendSOS", (sosData) => {
    console.log("SOS received:", sosData);

    const enhancedSOSData = {
      ...sosData,
      status: "pending",
      timestamp: new Date(),
    };

    activeSOS.set(sosData.sosId, enhancedSOSData);

    // Notify drivers
    ambulanceDrivers.forEach((driver, driverSocketId) => {
      io.to(driverSocketId).emit("receiveSOS", enhancedSOSData);
    });

    // Notify hospitals
    hospitals.forEach((hospital, hospitalSocketId) => {
      io.to(hospitalSocketId).emit("newSOS", enhancedSOSData);
    });

    socket.emit("sosConfirmed", {
      message: "SOS sent to ambulance drivers",
      sosId: sosData.sosId,
    });
  });

  // 🚑 Driver accepts SOS
  socket.on("acceptSOS", (acceptData) => {
    const sosRecord = activeSOS.get(acceptData.sosId);
    const driver = ambulanceDrivers.get(socket.id);

    if (sosRecord && sosRecord.status === "pending" && driver) {
      sosRecord.status = "accepted";
      sosRecord.acceptedBy = driver.name;
      sosRecord.driverSocketId = socket.id;
      sosRecord.driverLicense = driver.ambulanceLicense || "N/A";
      sosRecord.acceptedAt = new Date();

      // ✅ Find nearest hospital
      let nearestHospital = null;
      let minDistance = Infinity;

      if (sosRecord.location && sosRecord.location.includes(",")) {
        const [userLat, userLng] = sosRecord.location.split(",").map((c) => parseFloat(c.trim()));

        hospitals.forEach((hospital) => {
          if (hospital.lat && hospital.lng) {
            const dist = getDistance(userLat, userLng, hospital.lat, hospital.lng);
            if (dist < minDistance) {
              minDistance = dist;
              nearestHospital = {
                name: hospital.name,
                address: hospital.address,
                distance: dist.toFixed(2),
                hospitalSocketId: hospital.socketId,
              };
            }
          }
        });
      }

      sosRecord.nearestHospital = nearestHospital;

      // Notify driver
      socket.emit("sosAccepted", {
        sosId: acceptData.sosId,
        message: "You accepted the SOS",
        nearestHospital,
      });

      // Notify the chosen hospital: “Driver X is bringing Patient Y”
      if (nearestHospital && nearestHospital.hospitalSocketId) {
        io.to(nearestHospital.hospitalSocketId).emit("incomingPatient", {
          sosId: acceptData.sosId,
          patientName: sosRecord.userName,
          patientMobile: sosRecord.userMobile,
          driverName: driver.name,
          driverLicense: driver.ambulanceLicense || "N/A",
          eta: "On the way 🚑",
          distance: nearestHospital.distance + " km",
          emergencyType: sosRecord.type,
          patientLocation: sosRecord.location,
          isNearestHospital: true,
        });
        
        console.log(`🏥 Notifying ${nearestHospital.name}: Driver ${driver.name} bringing patient ${sosRecord.userName}`);
      }

      // Also notify all hospitals about the SOS acceptance
      hospitals.forEach((hospital, hospitalSocketId) => {
        io.to(hospitalSocketId).emit("sosAccepted", {
          sosId: acceptData.sosId,
          driverName: driver.name,
          patientName: sosRecord.userName,
          nearestHospital: nearestHospital,
        });
      });

      console.log(`🚑 SOS ${acceptData.sosId} accepted by ${driver.name}. Going to ${nearestHospital?.name}`);
    } else {
      socket.emit("sosAcceptFailed", {
        sosId: acceptData.sosId,
        message: "SOS already taken or not found",
      });
    }
  });

  // 🏥 Patient arrival confirmation
  socket.on("patientArrived", (data) => {
    const sosRecord = activeSOS.get(data.sosId);
    if (sosRecord) {
      sosRecord.status = "completed";
      sosRecord.completedAt = new Date();

      // Notify hospital
      hospitals.forEach((hospital, hospitalSocketId) => {
        io.to(hospitalSocketId).emit("patientArrived", {
          sosId: data.sosId,
          hospital: sosRecord.nearestHospital?.name || data.hospital,
          driverName: data.driverName,
          arrivalTime: new Date(),
        });
      });
    }
  });

  // ❌ Disconnect handling
  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);

    if (ambulanceDrivers.has(socket.id)) {
      const driver = ambulanceDrivers.get(socket.id);
      console.log(`Driver ${driver.name} disconnected`);
      ambulanceDrivers.delete(socket.id);
      io.emit("driverCountUpdate", { count: ambulanceDrivers.size });
    }

    if (hospitals.has(socket.id)) {
      const hospital = hospitals.get(socket.id);
      console.log(`Hospital ${hospital.name} disconnected`);
      hospitals.delete(socket.id);
    }

    // Reset SOS if driver disconnected
    activeSOS.forEach((sos, sosId) => {
      if (sos.driverSocketId === socket.id) {
        sos.status = "pending";
        delete sos.acceptedBy;
        delete sos.driverSocketId;
        console.log(`SOS ${sosId} returned to pending due to driver disconnect`);

        ambulanceDrivers.forEach((driver, driverSocketId) => {
          io.to(driverSocketId).emit("receiveSOS", sos);
        });
      }
    });
  });
});

// ♻️ Clean old SOS every 5 minutes
setInterval(() => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  activeSOS.forEach((sos, sosId) => {
    if (sos.timestamp < oneHourAgo) {
      activeSOS.delete(sosId);
      console.log(`Cleaned up old SOS: ${sosId}`);
    }
  });
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`🚑 QuikAid Emergency Server running at http://localhost:${PORT}`);
  console.log(`📱 Open http://localhost:${PORT} to start`);
  console.log(`👨‍⚕️ Login at http://localhost:${PORT}/login`);
  console.log(`🚗 Driver Dashboard at http://localhost:${PORT}/driver`);
  console.log(`🏥 Hospital Dashboard at http://localhost:${PORT}/hospital`);
});
