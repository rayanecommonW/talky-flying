import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installInput } from "./game/input.ts";
import "./styles.css";

installInput();
createRoot(document.getElementById("root")!).render(<App />);
