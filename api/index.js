process.env.SERVERLESS = process.env.SERVERLESS || "true";

export { app as default } from "../src/server.js";
