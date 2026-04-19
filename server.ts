import express from "express";
import { createServer as createHttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import helmet from "helmet";

// Initialize Express
const app = express();
const httpServer = createHttpServer(app);
const io = new SocketServer(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = 3000;

// Middleware
app.use(cors());
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for Vite dev mode
}));
app.use(express.json());

// Socket.io for real-time "Selected Question" state
let selectedQuestionId: string | null = null;

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Send current state to new connection
  socket.emit("selection_update", selectedQuestionId);

  socket.on("select_question", (questionId: string | null) => {
    selectedQuestionId = questionId;
    io.emit("selection_update", selectedQuestionId);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// Vite middleware setup
async function setupVite() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

setupVite();
