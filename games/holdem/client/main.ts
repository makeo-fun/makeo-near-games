// NEAR Hold'em's page: the glass table (client/glass, "Zero-G Glass Casino") on a real Makeo room.
// The front door (client/front.ts) opens the room; when play starts the table boots with the live
// adapter. The noir look is ./noir.html and the classic table ./classic.html.
import "./glass/story.js";
import "./glass/app.js";
import { runFront } from "./front.js";

runFront(() => (window as any).HOLDEM.mount());
