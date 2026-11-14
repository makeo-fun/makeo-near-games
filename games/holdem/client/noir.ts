// The noir table (client/noir), kept as a fallback look at ./noir.html. The glass table is index.html.
import "./noir/story.js";
import "./noir/portraits.js";
import "./noir/app.js";
import { runFront } from "./front.js";

runFront(() => (window as any).HOLDEM.mount());
