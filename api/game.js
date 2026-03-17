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
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

const db = admin.database();
const gamesRef = db.ref("games");

const ROWS = ["A", "B", "C", "D", "E"];
const COLS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

const allowedMoves = {
  A1: ["A2", "B1", "B2"], A2: ["A1", "A3", "B2"], A3: ["A2", "A4", "B2", "B3", "B4"],
  A4: ["A3", "A5", "B4"], A5: ["A4", "A6", "B4", "B5", "B6"], A6: ["A5", "A7", "B6"],
  A7: ["A6", "A8", "B6", "B7", "B8"], A8: ["A7", "A9", "B8"], A9: ["A8", "B8", "B9"],
  B1: ["A1", "B2", "C1"], B2: ["A1", "A2", "A3", "B1", "B3", "C1", "C2", "C3"],
  B3: ["A3", "B2", "B4", "C3"], B4: ["A3", "A4", "A5", "B3", "B5", "C3", "C4", "C5"],
  B5: ["A5", "B4", "B6", "C5"], B6: ["A5", "A6", "A7", "B5", "B7", "C5", "C6", "C7"],
  B7: ["A7", "B6", "B8", "C7"], B8: ["A7", "A8", "A9", "B7", "B9", "C7", "C8", "C9"],
  B9: ["A9", "B8", "C9"], C1: ["B1", "B2", "C2", "D1", "D2"], C2: ["B2", "C1", "C3", "D2"],
  C3: ["B2", "B3", "B4", "C2", "C4", "D2", "D3", "D4"], C4: ["B4", "C3", "C5", "D4"],
  C5: ["B4", "B5", "B6", "C4", "C6", "D4", "D5", "D6"], C6: ["B6", "C5", "C7", "D6"],
  C7: ["B6", "B7", "B8", "C6", "C8", "D6", "D7", "D8"], C8: ["B8", "C7", "C9", "D8"],
  C9: ["B8", "B9", "C8", "D8", "D9"], D1: ["C1", "D2", "E1"],
  D2: ["C1", "C2", "C3", "D1", "D3", "E1", "E2", "E3"], D3: ["C3", "D2", "D4", "E3"],
  D4: ["C3", "C4", "C5", "D3", "D5", "E3", "E4", "E5"], D5: ["C5", "D4", "D6", "E5"],
  D6: ["C5", "C6", "C7", "D5", "D7", "E5", "E6", "E7"], D7: ["C7", "D6", "D8", "E7"],
  D8: ["C7", "C8", "C9", "D7", "D9", "E7", "E8", "E9"], D9: ["C9", "D8", "E9"],
  E1: ["D1", "D2", "E2"], E2: ["D2", "E1", "E3"],
  E3: ["D2", "D3", "D4", "E2", "E4"], E4: ["D4", "E3", "E5"],
  E5: ["D4", "D5", "D6", "E4", "E6"], E6: ["D6", "E5", "E7"],
  E7: ["D6", "D7", "D8", "E6", "E8"], E8: ["D8", "E7", "E9"],
  E9: ["D8", "D9", "E8"],
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getCaptures(pieces, from, to, color) {
  const enemy = color === "mena" ? "maintso" : "mena";
  const r1 = ROWS.indexOf(from[0]), c1 = COLS.indexOf(from[1]);
  const r2 = ROWS.indexOf(to[0]),   c2 = COLS.indexOf(to[1]);
  const dr = r2 - r1, dc = c2 - c1;
  const scan = (startRow, startCol, dirRow, dirCol) => {
    const captured = [];
    let r = startRow + dirRow, c = startCol + dirCol;
    while (
      r >= 0 && r < 5 && c >= 0 && c < 9 &&
      pieces[ROWS[r] + COLS[c]] === enemy
    ) {
      captured.push(ROWS[r] + COLS[c]);
      r += dirRow;
      c += dirCol;
    }
    return captured;
  };
  return {
    approach:   scan(r2, c2,  dr,  dc),
    withdrawal: scan(r1, c1, -dr, -dc),
  };
}

function checkAvailableCaptures(pieces, spot, visited, lastDir, color) {
  const moves = allowedMoves[spot] || [];
  return moves.some((target) => {
    if (pieces[target] || (visited && visited.includes(target))) return false;
    const r1 = ROWS.indexOf(spot[0]),   c1 = COLS.indexOf(spot[1]);
    const r2 = ROWS.indexOf(target[0]), c2 = COLS.indexOf(target[1]);
    const dir = `${r2 - r1},${c2 - c1}`;
    if (lastDir === dir) return false;
    const caps = getCaptures(pieces, spot, target, color);
    return caps.approach.length > 0 || caps.withdrawal.length > 0;
  });
}

function playerHasAnyCapture(pieces, color) {
  for (const spot in pieces) {
    if (pieces[spot] === color) {
      for (const target of allowedMoves[spot] || []) {
        if (!pieces[target]) {
          const caps = getCaptures(pieces, spot, target, color);
          if (caps.approach.length > 0 || caps.withdrawal.length > 0) return true;
        }
      }
    }
  }
  return false;
}

function countPieces(pieces, color) {
  return Object.values(pieces).filter((v) => v === color).length;
}

/**
 * Vérifie si un joueur n'a plus aucun mouvement possible (bloqué).
 */
function playerHasNoMove(pieces, color) {
  for (const spot in pieces) {
    if (pieces[spot] === color) {
      for (const target of allowedMoves[spot] || []) {
        if (!pieces[target]) return false;
      }
    }
  }
  return true;
}

/**
 * Détermine le gagnant s'il y en a un.
 * Retourne "maintso" | "mena" | null
 */
function getWinner(pieces, nextTurn) {
  const mena     = countPieces(pieces, "mena");
  const maintso  = countPieces(pieces, "maintso");
  if (mena === 0)    return "maintso";
  if (maintso === 0) return "mena";
  if (playerHasNoMove(pieces, nextTurn)) {
    return nextTurn === "mena" ? "maintso" : "mena";
  }
  return null;
}

// ─── LOCK helpers (anti-double-submit, anti-race) ───────────────────────────

const LOCK_TTL_MS = 8000; // 8 secondes max pour un move

/**
 * Tente d'acquérir un lock atomique via transaction Firebase.
 * Retourne { acquired, game } 
 */
async function acquireLock(gameRef, uid) {
  let acquiredGame = null;
  const { committed } = await gameRef.transaction((game) => {
    if (!game) return; // aborts transaction
    const now = Date.now();
    // Lock déjà actif par quelqu'un d'autre
    if (
      game.processingMove &&
      game.lockOwner !== uid &&
      game.lockExpiry > now
    ) {
      return; // aborts — ne fait rien
    }
    game.processingMove = true;
    game.lockOwner = uid;
    game.lockExpiry = now + LOCK_TTL_MS;
    acquiredGame = game;
    return game;
  });
  return { acquired: committed && acquiredGame !== null, game: acquiredGame };
}

async function releaseLock(gameRef) {
  await gameRef.update({
    processingMove: false,
    lockOwner: null,
    lockExpiry: 0,
  });
}

// ─── Main handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed." });

  const { action, ...payload } = req.body;
  try {
    switch (action) {
      case "make-move":       return await handleMakeMove(payload, res);
      case "resolve-capture": return await handleResolveCapture(payload, res);
      case "stop-turn":       return await handleStopTurn(payload, res);
      case "get-game":        return await handleGetGame(payload, res);
      default:                return res.status(400).json({ error: "Invalid action." });
    }
  } catch (err) {
    console.error("[handler error]", err);
    return res.status(500).json({ error: "Server error.", detail: err.message });
  }
}

// ─── get-game ────────────────────────────────────────────────────────────────

async function handleGetGame({ uid, gameId }, res) {
  if (!gameId) return res.status(400).json({ error: "Missing gameId." });
  const snap = await gamesRef.child(gameId).once("value");
  if (!snap.exists()) return res.status(404).json({ error: "Game not found." });
  return res.status(200).json({ success: true, game: snap.val() });
}

// ─── make-move ───────────────────────────────────────────────────────────────

async function handleMakeMove({ uid, gameId, origin, target, clientVersion }, res) {
  if (!uid || !gameId || !origin || !target)
    return res.status(400).json({ error: "Missing parameters." });

  const gameRef = gamesRef.child(gameId);

  // 1. Acquérir le lock atomique
  const { acquired, game } = await acquireLock(gameRef, uid);
  if (!acquired)
    return res.status(409).json({ error: "Move in progress, please wait.", retryable: true });

  try {
    // 2. Vérification de version (anti-stale move)
    if (
      clientVersion !== undefined &&
      game.version !== undefined &&
      clientVersion !== game.version
    ) {
      return res.status(409).json({ error: "State mismatch, please resync.", retryable: false });
    }

    const myColor = game.senderUid === uid ? "maintso" : "mena";

    if (game.winner)
      return res.status(400).json({ error: "Game already finished." });
    if (game.turn !== myColor)
      return res.status(400).json({ error: "Not your turn." });

    // 3. Valider que origin appartient au joueur
    const pieces = game.pieces || {};
    if (pieces[origin] !== myColor)
      return res.status(400).json({ error: "That piece is not yours." });
    if (pieces[target])
      return res.status(400).json({ error: "Target square is occupied." });

    // 4. Valider que le mouvement est dans allowedMoves
    if (!(allowedMoves[origin] || []).includes(target))
      return res.status(400).json({ error: "Move not allowed." });

    // 5. Si une pièce est déjà en train de se déplacer, bloquer les autres
    if (game.movingPiece && game.movingPiece !== origin)
      return res.status(400).json({ error: "Another piece is still moving." });

    // 6. Obligation de capture si disponible
    const hasCapture = playerHasAnyCapture(pieces, myColor);
    const caps = getCaptures(pieces, origin, target, myColor);
    const moveHasCapture = caps.approach.length > 0 || caps.withdrawal.length > 0;
    if (hasCapture && !moveHasCapture)
      return res.status(400).json({ error: "You must capture if possible." });

    // 7. Calcul du nouvel état
    const r1 = ROWS.indexOf(origin[0]), c1 = COLS.indexOf(origin[1]);
    const r2 = ROWS.indexOf(target[0]), c2 = COLS.indexOf(target[1]);
    const dir = `${r2 - r1},${c2 - c1}`;
    const newVisited = [...(game.visited || []), origin];

    let newPieces = { ...pieces };
    delete newPieces[origin];
    newPieces[target] = myColor;

    let newMovingPiece   = target;
    let newLastDir       = dir;
    let newAwaitingCapture = false;
    let newPendingApproach = [];
    let newPendingWithdrawal = [];
    let newTurn = game.turn;

    if (caps.approach.length > 0 && caps.withdrawal.length > 0) {
      // Joueur doit choisir
      newAwaitingCapture   = true;
      newPendingApproach   = caps.approach;
      newPendingWithdrawal = caps.withdrawal;
    } else if (caps.approach.length > 0 || caps.withdrawal.length > 0) {
      const toRemove = caps.approach.length > 0 ? caps.approach : caps.withdrawal;
      toRemove.forEach((s) => delete newPieces[s]);
      const canContinue = checkAvailableCaptures(newPieces, target, newVisited, dir, myColor);
      if (!canContinue) {
        newMovingPiece = null;
        newTurn = myColor === "maintso" ? "mena" : "maintso";
      }
    } else {
      newMovingPiece = null;
      newTurn = myColor === "maintso" ? "mena" : "maintso";
    }

    const winner = newMovingPiece
      ? null
      : getWinner(newPieces, newTurn);

    const update = {
      pieces:            newPieces,
      turn:              winner ? game.turn : newTurn,
      movingPiece:       newMovingPiece ?? null,
      visited:           newMovingPiece ? newVisited : [],
      lastDir:           newMovingPiece ? newLastDir : "",
      awaitingCapture:   newAwaitingCapture,
      pendingApproach:   newPendingApproach,
      pendingWithdrawal: newPendingWithdrawal,
      winner:            winner ?? null,
      lastMoveAt:        admin.database.ServerValue.TIMESTAMP,
      version:           (game.version || 0) + 1,
      // Lock libéré
      processingMove: false,
      lockOwner:      null,
      lockExpiry:     0,
    };

    await gameRef.update(update);
    return res.status(200).json({ success: true, game: update });

  } catch (err) {
    // Toujours libérer le lock en cas d'erreur
    await releaseLock(gameRef).catch(() => {});
    throw err;
  }
}

// ─── resolve-capture ─────────────────────────────────────────────────────────

async function handleResolveCapture({ uid, gameId, capturedSpot, clientVersion }, res) {
  if (!uid || !gameId || !capturedSpot)
    return res.status(400).json({ error: "Missing parameters." });

  const gameRef = gamesRef.child(gameId);
  const { acquired, game } = await acquireLock(gameRef, uid);
  if (!acquired)
    return res.status(409).json({ error: "Move in progress, please wait.", retryable: true });

  try {
    if (clientVersion !== undefined && game.version !== undefined && clientVersion !== game.version)
      return res.status(409).json({ error: "State mismatch, please resync.", retryable: false });

    const myColor = game.senderUid === uid ? "maintso" : "mena";

    if (!game.awaitingCapture)
      return res.status(400).json({ error: "No pending capture to resolve." });

    const inApproach   = (game.pendingApproach || []).includes(capturedSpot);
    const inWithdrawal = (game.pendingWithdrawal || []).includes(capturedSpot);
    if (!inApproach && !inWithdrawal)
      return res.status(400).json({ error: "Invalid capture spot." });

    const toRemove = inApproach ? game.pendingApproach : game.pendingWithdrawal;
    let newPieces = { ...game.pieces };
    toRemove.forEach((s) => delete newPieces[s]);

    const further = checkAvailableCaptures(
      newPieces, game.movingPiece, game.visited, game.lastDir, myColor
    );
    const nextTurn = myColor === "maintso" ? "mena" : "maintso";
    const newTurn  = further ? game.turn : nextTurn;
    const winner   = further ? null : getWinner(newPieces, nextTurn);

    const update = {
      pieces:            newPieces,
      turn:              winner ? game.turn : newTurn,
      movingPiece:       further ? game.movingPiece : null,
      visited:           further ? game.visited : [],
      lastDir:           further ? game.lastDir : "",
      awaitingCapture:   false,
      pendingApproach:   [],
      pendingWithdrawal: [],
      winner:            winner ?? null,
      lastMoveAt:        admin.database.ServerValue.TIMESTAMP,
      version:           (game.version || 0) + 1,
      processingMove:    false,
      lockOwner:         null,
      lockExpiry:        0,
    };

    await gameRef.update(update);
    return res.status(200).json({ success: true, game: update });

  } catch (err) {
    await releaseLock(gameRef).catch(() => {});
    throw err;
  }
}

// ─── stop-turn ───────────────────────────────────────────────────────────────

async function handleStopTurn({ uid, gameId, clientVersion }, res) {
  if (!uid || !gameId)
    return res.status(400).json({ error: "Missing parameters." });

  const gameRef = gamesRef.child(gameId);
  const { acquired, game } = await acquireLock(gameRef, uid);
  if (!acquired)
    return res.status(409).json({ error: "Move in progress, please wait.", retryable: true });

  try {
    if (clientVersion !== undefined && game.version !== undefined && clientVersion !== game.version)
      return res.status(409).json({ error: "State mismatch, please resync.", retryable: false });

    const myColor  = game.senderUid === uid ? "maintso" : "mena";
    if (game.turn !== myColor)
      return res.status(400).json({ error: "Not your turn." });

    // stop-turn valide seulement si le joueur est déjà en capture multiple
    if (!game.movingPiece)
      return res.status(400).json({ error: "No active move to stop." });

    const nextTurn = myColor === "maintso" ? "mena" : "maintso";
    const winner   = getWinner(game.pieces, nextTurn);

    const update = {
      turn:              winner ? game.turn : nextTurn,
      movingPiece:       null,
      visited:           [],
      lastDir:           "",
      awaitingCapture:   false,
      pendingApproach:   [],
      pendingWithdrawal: [],
      winner:            winner ?? null,
      lastMoveAt:        admin.database.ServerValue.TIMESTAMP,
      version:           (game.version || 0) + 1,
      processingMove:    false,
      lockOwner:         null,
      lockExpiry:        0,
    };

    await gameRef.update(update);
    return res.status(200).json({ success: true, game: update });

  } catch (err) {
    await releaseLock(gameRef).catch(() => {});
    throw err;
  }
}
