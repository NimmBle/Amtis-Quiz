const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const db = require("./db");
const path = require("path");
const registerAdminHandlers = require("./handlers/admin");
const registerPlayerHandlers = require("./handlers/player");
const utils = require("./handlers/utils");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);
  registerPlayerHandlers(io, db, socket, utils);
  registerAdminHandlers(io, db, socket, utils);
});

server.listen(3000, () => console.log("Server running on http://localhost:3000"));
