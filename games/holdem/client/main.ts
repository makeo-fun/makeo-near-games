// Customize the rules template and replace this scaffold with your game's UI.
export {};
const games = await MakeoGames.ready();
let play: MakeoContestPlay | null = null;

async function joinAndPlay(roomId: string) {
  play?.dispose();
  const room = await MakeoRooms.join(roomId);
  play = await games.contests.play(room);
  const status = document.getElementById("status");
  if (status) status.textContent = "Room connected. Build your game's presentation here.";
}

games.contests.onRoom(({ room }) => joinAndPlay(room));
