import { listen } from "@colyseus/tools";
import { config } from "./config.ts";
import app from "./app.config.ts";

listen(app, config.port);
