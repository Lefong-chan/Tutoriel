// /api/game.js
import admin from "firebase-admin";

if (!process.env.FIREBASE_KEY) throw new Error("FIREBASE_KEY not set");
const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const db = admin.database();
const gamesRef = db.ref("games");

// ─── Constantes du jeu ─────────────────────────────────────────────
const ROWS = ['A','B','C','D','E'];
const COLS = ['1','2','3','4','5','6','7','8','9'];

const allowedMoves = {
  'A1': ['A2','B1','B2'], 'A2': ['A1','A3','B2'], 'A3': ['A2','A4','B2','B3','B4'],
  'A4': ['A3','A5','B4'], 'A5': ['A4','A6','B4','B5','B6'], 'A6': ['A5','A7','B6'],
  'A7': ['A6','A8','B6','B7','B8'], 'A8': ['A7','A9','B8'], 'A9': ['A8','B8','B9'],
  'B1': ['A1','B2','C1'], 'B2': ['A1','A2','A3','B1','B3','C1','C2','C3'],
  'B3': ['A3','B2','B4','C3'], 'B4': ['A3','A4','A5','B3','B5','C3','C4','C5'],
  'B5': ['A5','B4','B6','C5'], 'B6': ['A5','A6','A7','B5','B7','C5','C6','C7'],
  'B7': ['A7','B6','B8','C7'], 'B8': ['A7','A8','A9','B7','B9','C7','C8','C9'],
  'B9': ['A9','B8','C9'], 'C1': ['B1','B2','C2','D1','D2'], 'C2': ['B2','C1','C3','D2'],
  'C3': ['B2','B3','B4','C2','C4','D2','D3','D4'], 'C4': ['B4','C3','C5','D4'],
  'C5': ['B4','B5','B6','C4','C6','D4','D5','D6'], 'C6': ['B6','C5','C7','D6'],
  'C7': ['B6','B7','B8','C6','C8','D6','D7','D8'], 'C8': ['B8','C7','C9','D8'],
  'C9': ['B8','B9','C8','D8','D9'], 'D1': ['C1','D2','E1'], 'D2': ['C1','C2','C3','D1','D3','E1','E2','E3'],
  'D3': ['C3','D2','D4','E3'], 'D4': ['C3','C4','C5','D3','D5','E3','E4','E5'],
  'D5': ['C5','D4','D6','E5'], 'D6': ['C5','C6','C7','D5','D7','E5','E6','E7'],
  'D7': ['C7','D6','D8','E7'], 'D8': ['C7','C8','C9','D7','D9','E7','E8','E9'],
  'D9': ['C9','D8','E9'], 'E1': ['D1','D2','E2'], 'E2': ['D2','E1','E3'],
  'E3': ['D2','D3','D4','E2','E4'], 'E4': ['D4','E3','E5'], 'E5': ['D4','D5','D6','E4','E6'],
  'E6': ['D6','E5','E7'], 'E7': ['D6','D7','D8','E6','E8'], 'E8': ['D8','E7','E9'],
  'E9': ['D8','D9','E8']
};

// ─── Fonctions de validation ───────────────────────────────────────
function getCaptures(pieces, from, to, color) {
  const enemy = color === "mena" ? "maintso" : "mena";
  const r1 = ROWS.indexOf(from[0]), c1 = COLS.indexOf(from[1]);
  const r2 = ROWS.indexOf(to[0]),   c2 = COLS.indexOf(to[1]);
  const dr = r2 - r1, dc = c2 - c1;

  const scan = (startRow, startCol, dirRow, dirCol) => {
    const captured = [];
    let r = startRow + dirRow, c = startCol + dirCol;
    while (r >= 0 && r < 5 && c >= 0 && c < 9 && pieces[ROWS[r] + COLS[c]] === enemy) {
      captured.push(ROWS[r] + COLS[c]);
      r += dirRow;
      c += dirCol;
    }
    return captured;
  };

  return {
    approach: scan(r2, c2, dr, dc),
    withdrawal: scan(r1, c1, -dr, -dc)
  };
}

function playerHasAnyCapture(pieces, color) {
  for (let spot in pieces) {
    if (pieces[spot] === color) {
      const moves = allowedMoves[spot] || [];
      for (let target of moves) {
        if (!pieces[target]) {
          const caps = getCaptures(pieces, spot, target, color);
          if (caps.approach.length > 0 || caps.withdrawal.length > 0) return true;
        }
      }
    }
  }
  return false;
}

function checkAvailableCaptures(pieces, spot, visited, lastDir, color) {
  const moves = allowedMoves[spot] || [];
  return moves.some(target => {
    if (pieces[target] || (visited && visited.includes(target))) return false;
    const r1 = ROWS.indexOf(spot[0]), c1 = COLS.indexOf(spot[1]);
    const r2 = ROWS.indexOf(target[0]), c2 = COLS.indexOf(target[1]);
    if (lastDir === `${r2 - r1},${c2 - c1}`) return false;
    const caps = getCaptures(pieces, spot, target, color);
    return caps.approach.length > 0 || caps.withdrawal.length > 0;
  });
}

// ─── Gestionnaire principal ───────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  if (allowedOrigin && req.headers.origin !== allowedOrigin)
    return res.status(403).json({ error: "Forbidden." });

  const { action, ...payload } = req.body;
  if (!action) return res.status(400).json({ error: "Action required." });

  try {
    switch (action) {
      case "make-move":        return await handleMakeMove(payload, res);
      case "resolve-capture":  return await handleResolveCapture(payload, res);
      case "stop-turn":        return await handleStopTurn(payload, res);
      case "get-game":         return await handleGetGame(payload, res);
      default: return res.status(400).json({ error: "Invalid action." });
    }
  } catch (err) {
    console.error(`GAME ERROR [${action}]:`, err);
    return res.status(500).json({ error: "An unexpected server error occurred." });
  }
}

// ─── Handlers (identiques à la version précédente) ─────────────────
async function handleGetGame({ uid, gameId }, res) {
  if (!uid || !gameId) return res.status(400).json({ error: "UID and gameId required." });
  const snap = await gamesRef.child(gameId).once("value");
  if (!snap.exists()) return res.status(404).json({ error: "Game not found." });
  const game = snap.val();
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });
  return res.status(200).json({ success: true, game });
}

async function handleMakeMove({ uid, gameId, origin, target }, res) {
  if (!uid || !gameId || !origin || !target)
    return res.status(400).json({ error: "Missing parameters." });

  const gameRef = gamesRef.child(gameId);
  const snap = await gameRef.once("value");
  if (!snap.exists()) return res.status(404).json({ error: "Game not found." });
  const game = snap.val();

  const isSender = game.senderUid === uid;
  const isReceiver = game.receiverUid === uid;
  if (!isSender && !isReceiver) return res.status(403).json({ error: "Not authorized." });
  const myColor = isSender ? "maintso" : "mena";
  if (game.turn !== myColor) return res.status(400).json({ error: "Not your turn." });

  const pieces = game.pieces || {};
  const movingPiece = game.movingPiece || null;
  const visited = game.visited || [];
  const lastDir = game.lastDir || "";
  const awaitingCapture = game.awaitingCapture || false;

  if (awaitingCapture) return res.status(400).json({ error: "You must resolve pending capture first." });
  if (movingPiece && origin !== movingPiece)
    return res.status(400).json({ error: "You must continue with the same piece." });
  if (!pieces[origin] || pieces[origin] !== myColor)
    return res.status(400).json({ error: "Invalid origin piece." });
  if (pieces[target]) return res.status(400).json({ error: "Target is not empty." });
  if (!allowedMoves[origin] || !allowedMoves[origin].includes(target))
    return res.status(400).json({ error: "Invalid move." });
  if (visited.includes(target)) return res.status(400).json({ error: "Cannot go back to visited spot." });

  const r1 = ROWS.indexOf(origin[0]), c1 = COLS.indexOf(origin[1]);
  const r2 = ROWS.indexOf(target[0]), c2 = COLS.indexOf(target[1]);
  const dir = `${r2 - r1},${c2 - c1}`;
  if (movingPiece && lastDir === dir) return res.status(400).json({ error: "Cannot reverse direction." });

  const anyCapture = playerHasAnyCapture(pieces, myColor);
  const caps = getCaptures(pieces, origin, target, myColor);
  const isCaptureMove = caps.approach.length > 0 || caps.withdrawal.length > 0;
  if (anyCapture && !isCaptureMove) return res.status(400).json({ error: "You must capture." });

  let newPieces = { ...pieces };
  delete newPieces[origin];
  newPieces[target] = myColor;

  const newVisited = [...visited, origin];
  let newMovingPiece = target;
  let newLastDir = dir;
  let newAwaitingCapture = false;
  let newPendingApproach = [];
  let newPendingWithdrawal = [];
  let newTurn = game.turn;

  if (caps.approach.length > 0 && caps.withdrawal.length > 0) {
    newAwaitingCapture = true;
    newPendingApproach = caps.approach;
    newPendingWithdrawal = caps.withdrawal;
  } else if (isCaptureMove) {
    const toRemove = caps.approach.length > 0 ? caps.approach : caps.withdrawal;
    toRemove.forEach(spot => delete newPieces[spot]);

    const further = checkAvailableCaptures(newPieces, target, newVisited, newLastDir, myColor);
    if (!further) {
      newMovingPiece = null;
      newVisited.length = 0;
      newLastDir = "";
      newTurn = game.turn === "maintso" ? "mena" : "maintso";
    }
  } else {
    newMovingPiece = null;
    newVisited.length = 0;
    newLastDir = "";
    newTurn = game.turn === "maintso" ? "mena" : "maintso";
  }

  await gameRef.update({
    pieces: newPieces,
    turn: newTurn,
    movingPiece: newMovingPiece,
    visited: newVisited,
    lastDir: newLastDir,
    awaitingCapture: newAwaitingCapture,
    pendingApproach: newPendingApproach,
    pendingWithdrawal: newPendingWithdrawal
  });

  return res.status(200).json({ success: true });
}

async function handleResolveCapture({ uid, gameId, capturedSpot }, res) {
  if (!uid || !gameId || !capturedSpot)
    return res.status(400).json({ error: "Missing parameters." });
  
  const gameRef = gamesRef.child(gameId);
  const snap = await gameRef.once("value");
  if (!snap.exists()) return res.status(404).json({ error: "Game not found." });
  const game = snap.val();
  
  const isSender = game.senderUid === uid;
  const isReceiver = game.receiverUid === uid;
  if (!isSender && !isReceiver) return res.status(403).json({ error: "Not authorized." });
  const myColor = isSender ? "maintso" : "mena";
  if (game.turn !== myColor) return res.status(400).json({ error: "Not your turn." });
  if (!game.awaitingCapture) return res.status(400).json({ error: "No pending capture." });
  
  const pendingApproach = game.pendingApproach || [];
  const pendingWithdrawal = game.pendingWithdrawal || [];
  let toRemove = null;
  if (pendingApproach.includes(capturedSpot)) {
    toRemove = pendingApproach;
  } else if (pendingWithdrawal.includes(capturedSpot)) {
    toRemove = pendingWithdrawal;
  } else {
    return res.status(400).json({ error: "Invalid capture target." });
  }
  
  let newPieces = { ...game.pieces };
  toRemove.forEach(spot => delete newPieces[spot]);
  
  const movingPiece = game.movingPiece;
  const visited = game.visited || [];
  const lastDir = game.lastDir || "";
  const further = checkAvailableCaptures(newPieces, movingPiece, visited, lastDir, myColor);
  
  let newMovingPiece = movingPiece;
  let newVisited = [...visited];
  let newLastDir = lastDir;
  let newAwaitingCapture = false;
  let newPendingApproach = [];
  let newPendingWithdrawal = [];
  let newTurn = game.turn;
  
  if (!further) {
    newMovingPiece = null;
    newVisited = [];
    newLastDir = "";
    newTurn = game.turn === "maintso" ? "mena" : "maintso";
  }
  
  await gameRef.update({
    pieces: newPieces,
    turn: newTurn,
    movingPiece: newMovingPiece,
    visited: newVisited,
    lastDir: newLastDir,
    awaitingCapture: newAwaitingCapture,
    pendingApproach: newPendingApproach,
    pendingWithdrawal: newPendingWithdrawal
  });
  
  return res.status(200).json({ success: true });
}

async function handleStopTurn({ uid, gameId }, res) {
  if (!uid || !gameId) return res.status(400).json({ error: "Missing parameters." });
  
  const gameRef = gamesRef.child(gameId);
  const snap = await gameRef.once("value");
  if (!snap.exists()) return res.status(404).json({ error: "Game not found." });
  const game = snap.val();
  
  const isSender = game.senderUid === uid;
  const isReceiver = game.receiverUid === uid;
  if (!isSender && !isReceiver) return res.status(403).json({ error: "Not authorized." });
  const myColor = isSender ? "maintso" : "mena";
  if (game.turn !== myColor) return res.status(400).json({ error: "Not your turn." });
  if (!game.movingPiece) return res.status(400).json({ error: "No ongoing capture chain." });
  
  await gameRef.update({
    turn: game.turn === "maintso" ? "mena" : "maintso",
    movingPiece: null,
    visited: [],
    lastDir: "",
    awaitingCapture: false,
    pendingApproach: [],
    pendingWithdrawal: []
  });
  
  return res.status(200).json({ success: true });
}
