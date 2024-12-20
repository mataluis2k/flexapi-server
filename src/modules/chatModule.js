const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const { getDbConnection } = require("./db");
class ChatModule {
    constructor(httpServer, app, jwtSecret, dbConfig, corsOptions) {
        // Initialize Socket.IO
        this.io = new Server(httpServer, {
            cors: {
                origin: corsOptions.origin, // Update based on your frontend origin
                methods: corsOptions.methods,
            },
        });

        this.jwtSecret = jwtSecret;
        this.connectedUsers = new Map();
        this.rooms = new Map(); // Store group room information

        // Initialize database connection pool
        this.dbPool = mysql.createPool(dbConfig);

        this.app = app; // Reference to the existing Express app
    }

    async saveMessage({ senderId, recipientId, groupName, message, status }) {
        const dbType = process.env.STREAMING_DBTYPE || "mysql";
        const dbConnection = process.env.DBSTREAMING_DBCONNECTION || "MYSQL_1";
    
        const config = { dbType, dbConnection };            
        const timestamp = new Date().toISOString();
    
        const sql = `
            INSERT INTO messages (sender_id, recipient_id, group_name, message, status, timestamp)
            VALUES (?, ?, ?, ?, ?, NOW())
        `;
    
        const values = [senderId, recipientId, groupName, message, status];
    
        try {
            // Get the database connection
            const connection = await getDbConnection(config);
    
            // Execute the query
            const [result] = await connection.execute(sql, values);
    
            console.log("Message saved successfully:", result);          
        } catch (error) {
            console.error("Error saving message:", error.message);
        }
    }

    start() {
        // Middleware: Authenticate users
        this.io.use((socket, next) => {
            const token = socket.handshake.auth?.token;
            if (!token) return next(new Error("Authentication error"));

            jwt.verify(token, this.jwtSecret, (err, user) => {
                if (err) return next(new Error("Invalid token"));
                socket.user = user; // Attach user data to the socket
                next();
            });
        });

        this.io.on("connection", (socket) => {
            console.log(`User connected: ${socket.id}, username: ${socket.user.username}`);

            // Track connected user
            this.connectedUsers.set(socket.user.username, socket.id);

            // Event: One-to-one message
            socket.on("privateMessage", async ({ recipientId, message }) => {
                console.log(`Private message from ${socket.user.username} to ${recipientId}: ${message}`);
                try{
                const recipientSocketId = this.connectedUsers.get(recipientId);

                // Save message in the database
                const messageData = {
                    senderId: socket.user.username,
                    recipientId,
                    groupName: null,
                    message,
                    status: recipientSocketId ? "delivered" : "pending",
                };
                await this.saveMessage(messageData);

                // Send the message if the recipient is online
                if (recipientSocketId) {
                    this.io.to(recipientSocketId).emit("privateMessage", {
                        from: socket.user.username,
                        to: recipientId,
                        text: message,
                        timestamp: new Date().toISOString(),
                    });
                } else {
                    socket.emit("info", `User ${recipientId} is offline. Message saved.`);
                }
            } catch (error) {
                console.error("Error handling privateMessage event:", error.message);
                socket.emit("error", "An error occurred while sending your message.");
            }
            });

            // Event: Create or join group
            socket.on("createOrJoinGroup", ({ groupName }) => {
                if (!this.rooms.has(groupName)) {
                    this.rooms.set(groupName, []);
                }
                this.rooms.get(groupName).push(socket.user.username);
                socket.join(groupName);
                this.io.to(groupName).emit("groupNotification", {
                    message: `User ${socket.user.username} joined the group.`,
                });
                console.log(`User ${socket.user.username} joined group: ${groupName}`);
            });

            // Event: Group message
            socket.on("groupMessage", async ({ groupName, message }) => {
                if (this.rooms.has(groupName)) {
                    // Save message in the database
                    const messageData = {
                        senderId: socket.user.username,
                        recipientId: null,
                        groupName,
                        message,
                        status: "delivered",
                    };
                    await this.saveMessage(messageData);

                    // Broadcast the message to group members
                    this.io.to(groupName).emit("groupMessage", {
                        senderId: socket.user.username,
                        message,
                        timestamp: new Date().toISOString(),
                    });
                } else {
                    socket.emit("error", `Group ${groupName} does not exist.`);
                }
            });

            // Event: Acknowledge receipt
            socket.on("messageReceived", async ({ messageId }) => {
                const query = `UPDATE messages SET status = ? WHERE id = ?`;
                try {
                    const connection = await this.dbPool.getConnection();
                    await connection.execute(query, ["read", messageId]);
                    connection.release();
                } catch (error) {
                    console.error("Error updating message status:", error.message);
                }
            });

            // Handle disconnection
            socket.on("disconnect", () => {
                this.connectedUsers.delete(socket.user.username);
                console.log(`User ${socket.user.username} disconnected.`);
            });
        });

        console.log("Chat module initialized with authentication, persistence, and receipts.");
    }
}

module.exports = ChatModule;
