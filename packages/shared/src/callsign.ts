const BIRDS = [
  "KESTREL", "HERON", "MAGPIE", "RAVEN", "SWIFT", "OSPREY", "CORVID", "WREN", "FINCH", "SHRIKE",
  "PLOVER", "MERLIN", "HOBBY", "ROOK", "JACKDAW", "LARK", "PIPIT", "TERN", "GANNET", "CURLEW",
];

const CALLSIGN_RE = /^[A-Z]{3,10}-\d{1,2}$/;

export function randomCallsign(rand: () => number = Math.random): string {
  const bird = BIRDS[Math.floor(rand() * BIRDS.length)];
  return `${bird}-${1 + Math.floor(rand() * 99)}`;
}

export function isCallsign(s: unknown): s is string {
  return typeof s === "string" && CALLSIGN_RE.test(s);
}
