// api/game-vela.js
import admin from "firebase-admin";
import jwt   from "jsonwebtoken";

if (!process.env.FIREBASE_KEY) throw new Error("FIREBASE_KEY not set");
if (!process.env.JWT_SECRET)   throw new Error("JWT_SECRET not set");

const allowedOrigin = process.env.ALLOWED_ORIGIN;
const jwtSecret     = process.env.JWT_SECRET;

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({
    credential:  admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const rtdb     = admin.database();
const gamesRef = rtdb.ref("games");

// ── JWT guard ──────────────────────────────────────────────────────────────
function verifyToken(req) {
  const header = req.headers["authorization"] || "";
  if (!header.startsWith("Bearer ")) return null;
  try {
    return jwt.verify(header.slice(7), jwtSecret);
  } catch {
    return null;
  }
}

async function rtdbGet(ref) {
  const snap = await ref.once("value");
  return snap.exists() ? snap.val() : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed." });
  if (allowedOrigin && req.headers.origin !== allowedOrigin)
    return res.status(403).json({ error: "Forbidden." });

  // ── JWT guard ─────────────────────────────────────────────────────────
  const decoded = verifyToken(req);
  if (!decoded) return res.status(401).json({ error: "Unauthorized Access" });

  const { action, ...payload } = req.body;
  if (!action) return res.status(400).json({ error: "Action required." });

  try {
    switch (action) {
      case "get-state":          return await handleGetState(payload, res);
      case "make-move":          return await handleMakeMove(payload, res);
      case "stop-move":          return await handleStopMove(payload, res);
      case "get-firebase-token": return await handleGetFirebaseToken(payload, res);
      case "update-timers":      return await handleUpdateTimers(payload, res);
      case "declare-winner":     return await handleDeclareWinner(payload, res);
      case "request-rematch":    return await handleRequestRematch(payload, res);
      case "accept-rematch":     return await handleAcceptRematch(payload, res);
      case "decline-rematch":    return await handleDeclineRematch(payload, res);
      case "mark-rematch-done":  return await handleMarkRematchDone(payload, res);
      case "auto-restart":       return await handleAutoRestart(payload, res);
      default: return res.status(400).json({ error: "Invalid action." });
    }
  } catch (err) {
    console.error(`GAME-VELA API ERROR [${action}]:`, err);
    return res.status(500).json({ error: "An unexpected server error occurred." });
  }
}

function getMyColor(game, uid) {
  return game.senderUid === uid
    ? (game.senderColor   || "maintso")
    : (game.receiverColor || "mena");
}

async function handleGetFirebaseToken(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId)
    return res.status(400).json({ error: "uid and gameId required." });

  const game = await rtdbGet(gamesRef.child(gameId));
  if (!game)
    return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });

  const token = await admin.auth().createCustomToken(uid);
  return res.status(200).json({ success: true, token });
}

async function handleGetState(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "uid and gameId required." });
  const game = await rtdbGet(gamesRef.child(gameId));
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });
  return res.status(200).json({ success: true, game });
}

function isPhase2(game) {
  const firstMover = game.firstMover;
  if (!firstMover) return false;
  const nonFMColor = firstMover === "maintso" ? "mena" : "maintso";
  const pieces     = game.pieces || {};
  const count      = Object.values(pieces).filter(v => v === nonFMColor).length;
  return count <= 5;
}

async function handleMakeMove(body, res) {
  const { uid, gameId, origin, target, capturedSpots = [], dir } = body;
  if (!uid || !gameId || !origin || !target)
    return res.status(400).json({ error: "uid, gameId, origin, target required." });

  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });

  const myColor    = getMyColor(game, uid);
  if (game.turn !== myColor) return res.status(400).json({ error: "Tsy anjaranao." });
  if (game.movingPiece && game.movingPiece !== origin)
    return res.status(400).json({ error: "Pio hafa tsy azo hetsehina izao." });

  const pieces     = { ...(game.pieces || {}) };
  const visited    = [...(game.visited || [])];
  const firstMover = game.firstMover || myColor;

  delete pieces[origin];
  pieces[target] = myColor;

  const phase2 = isPhase2(game);

  if (phase2) {
    if (Array.isArray(capturedSpots)) {
      capturedSpots.forEach(s => delete pieces[s]);
    }
    const newVisited  = [...visited, origin];
    const wasCapture  = capturedSpots.length > 0;
    const canContinue = wasCapture && ph2CheckAvailableCaptures(pieces, target, newVisited, dir, myColor);
    const prevHistory = Array.isArray(game.moveHistory) ? game.moveHistory : [];
    const histEntry   = { origin, target, capturedSpots: capturedSpots || [] };

    if (canContinue) {
      await gameRef.update({
        pieces, movingPiece: target, visited: newVisited,
        lastDir: dir || "", moveHistory: [...prevHistory, histEntry], firstMover
      });
      return res.status(200).json({ success: true, continuing: true });
    } else {
      const nextColor = myColor === "maintso" ? "mena" : "maintso";
      const nowMs2    = Date.now();
      const timerUpd2 = { timerRunning: nextColor, timerLastTick: nowMs2 };
      if (game.timerRunning && game.timerLastTick) {
        const el2 = Math.max(0, nowMs2 - game.timerLastTick);
        if (game.timerRunning === "maintso") timerUpd2.timerMaintso = Math.max(0, (game.timerMaintso||0)-el2);
        else timerUpd2.timerMena = Math.max(0, (game.timerMena||0)-el2);
      }
      const winner2 = checkGameOver(
        pieces,
        timerUpd2.timerMaintso !== undefined ? timerUpd2.timerMaintso : (game.timerMaintso||0),
        timerUpd2.timerMena    !== undefined ? timerUpd2.timerMena    : (game.timerMena||0),
        game.minutes
      );
      const payload2 = {
        pieces, turn: nextColor, movingPiece: "", visited: [], lastDir: "",
        moveHistory: [], lastTurnHistory: [...prevHistory, histEntry],
        lastTurnColor: myColor, firstMover, ...timerUpd2
      };
      if (winner2) payload2.winner = winner2;
      await gameRef.update(payload2);
      return res.status(200).json({ success: true, continuing: false, winner: winner2||null });
    }

  } else {
    const amIFirstMov       = firstMover === myColor;
    const canCapture        = amIFirstMov;
    const effectiveCaptured = canCapture && Array.isArray(capturedSpots) ? capturedSpots : [];

    if (effectiveCaptured.length > 0) {
      delete pieces[effectiveCaptured[0]];
    }

    const newVisited = [...visited, origin];
    const wasCapture = effectiveCaptured.length > 0;
    const nfmHasCont = game.nonFirstMoverHasContinued || false;

    const nonFMColor  = firstMover === "maintso" ? "mena" : "maintso";
    const advColor    = amIFirstMov ? nonFMColor : firstMover;
    const advCount    = Object.values(pieces).filter(v => v === advColor).length;
    const multiActive = amIFirstMov ? nfmHasCont : (advCount <= 5);
    const canContinue = multiActive && wasCapture
      && ph2CheckAvailableCaptures(pieces, target, newVisited, dir, myColor);

    const prevHistory = Array.isArray(game.moveHistory) ? game.moveHistory : [];
    const histEntry   = { origin, target, capturedSpots: effectiveCaptured };

    if (canContinue) {
      const newNFM = nfmHasCont || (!amIFirstMov);
      await gameRef.update({
        pieces, movingPiece: target, visited: newVisited,
        lastDir: dir || "", moveHistory: [...prevHistory, histEntry],
        firstMover, nonFirstMoverHasContinued: newNFM
      });
      return res.status(200).json({ success: true, continuing: true });
    } else {
      const nextColor = myColor === "maintso" ? "mena" : "maintso";
      const nowMs1    = Date.now();
      const timerUpd1 = { timerRunning: nextColor, timerLastTick: nowMs1 };
      if (game.timerRunning && game.timerLastTick) {
        const el1 = Math.max(0, nowMs1 - game.timerLastTick);
        if (game.timerRunning === "maintso") timerUpd1.timerMaintso = Math.max(0, (game.timerMaintso||0)-el1);
        else timerUpd1.timerMena = Math.max(0, (game.timerMena||0)-el1);
      }
      let winner1 = checkGameOver(
        pieces,
        timerUpd1.timerMaintso !== undefined ? timerUpd1.timerMaintso : (game.timerMaintso||0),
        timerUpd1.timerMena    !== undefined ? timerUpd1.timerMena    : (game.timerMena||0),
        game.minutes
      );
      if (!winner1 && nextColor === firstMover && isStillPhase1(pieces, firstMover)) {
        if (!ph1PlayerHasAnyCapture(pieces, firstMover)) winner1 = firstMover;
      }
      const payload1 = {
        pieces, turn: nextColor, movingPiece: "", visited: [], lastDir: "",
        moveHistory: [], lastTurnHistory: [...prevHistory, histEntry],
        lastTurnColor: myColor, firstMover,
        nonFirstMoverHasContinued: nfmHasCont, ...timerUpd1
      };
      if (winner1) payload1.winner = winner1;
      await gameRef.update(payload1);
      return res.status(200).json({ success: true, continuing: false, winner: winner1||null });
    }
  }
}

async function handleStopMove(body, res) {
  const { uid, gameId, pieces } = body;
  if (!uid || !gameId || !pieces)
    return res.status(400).json({ error: "uid, gameId, pieces required." });

  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });

  const myColor = getMyColor(game, uid);
  if (game.turn !== myColor) return res.status(400).json({ error: "Tsy anjaranao." });
  if (!game.movingPiece)     return res.status(400).json({ error: "Tsy misy movingPiece." });

  const nextColor    = myColor === "maintso" ? "mena" : "maintso";
  const stopHistory  = Array.isArray(game.moveHistory) ? game.moveHistory : [];
  const stopNow      = Date.now();
  const stopTimerUpd = { timerRunning: nextColor, timerLastTick: stopNow };
  if (game.timerRunning && game.timerLastTick) {
    const elapsed = Math.max(0, stopNow - game.timerLastTick);
    if (game.timerRunning === "maintso") stopTimerUpd.timerMaintso = Math.max(0, (game.timerMaintso||0)-elapsed);
    else stopTimerUpd.timerMena = Math.max(0, (game.timerMena||0)-elapsed);
  }
  let stopWinner = checkGameOver(
    pieces,
    stopTimerUpd.timerMaintso !== undefined ? stopTimerUpd.timerMaintso : (game.timerMaintso||0),
    stopTimerUpd.timerMena    !== undefined ? stopTimerUpd.timerMena    : (game.timerMena||0),
    game.minutes
  );
  const stopFM = game.firstMover || null;
  if (!stopWinner && stopFM && nextColor === stopFM && isStillPhase1(pieces, stopFM)) {
    if (!ph1PlayerHasAnyCapture(pieces, stopFM)) stopWinner = stopFM;
  }
  const stopPayload = {
    pieces, turn: nextColor, movingPiece: "", visited: [], lastDir: "",
    moveHistory: [], lastTurnHistory: stopHistory, lastTurnColor: myColor,
    firstMover: game.firstMover || null,
    nonFirstMoverHasContinued: game.nonFirstMoverHasContinued || false,
    ...stopTimerUpd
  };
  if (stopWinner) stopPayload.winner = stopWinner;
  await gameRef.update(stopPayload);
  return res.status(200).json({ success: true, winner: stopWinner||null });
}

async function handleUpdateTimers(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "uid and gameId required." });
  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });
  if (!game.timerRunning || !game.timerLastTick)
    return res.status(200).json({ success: true });

  const nowMs   = Date.now();
  const elapsed = Math.max(0, nowMs - game.timerLastTick);
  const upd     = { timerLastTick: nowMs };
  if (game.timerRunning === "maintso") {
    upd.timerMaintso = Math.max(0, (game.timerMaintso || 0) - elapsed);
  } else {
    upd.timerMena = Math.max(0, (game.timerMena || 0) - elapsed);
  }
  await gameRef.update(upd);
  return res.status(200).json({ success: true });
}

// ── Rematch ────────────────────────────────────────────────────────────────

async function handleRequestRematch(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "uid and gameId required." });
  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });
  if (game.source && game.source !== "vela")
    return res.status(400).json({ error: "Rematch only in Room Vela." });
  await gameRef.child("rematch").set({ requestedBy: uid, status: "pending", requestedAt: Date.now() });
  return res.status(200).json({ success: true });
}

async function handleAcceptRematch(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "uid and gameId required." });
  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });
  const rematch = game.rematch;
  if (!rematch || rematch.status !== "pending")
    return res.status(400).json({ error: "No pending rematch request." });
  if (rematch.requestedBy === uid)
    return res.status(400).json({ error: "Cannot accept your own request." });

  const rematchCount = (game.rematchCount || 0) + 1;
  let newFirstMover;
  if (game.winner === "maintso")       newFirstMover = "mena";
  else if (game.winner === "mena")     newFirstMover = "maintso";
  else                                 newFirstMover = "maintso";

  const R = ["A","B","C","D","E"], C = ["1","2","3","4","5","6","7","8","9"];
  const initialPieces = {};
  R.forEach((r, ri) => {
    C.forEach((c, ci) => {
      const key = r + c;
      if (ri < 2)      initialPieces[key] = "mena";
      else if (ri > 2) initialPieces[key] = "maintso";
      else {
        if ([1,3,6,8].includes(ci))      initialPieces[key] = "mena";
        else if ([0,2,5,7].includes(ci)) initialPieces[key] = "maintso";
      }
    });
  });

  const minutes     = game.minutes || null;
  const msPerPlayer = minutes ? minutes * 60 * 1000 : null;

  const resetData = {
    pieces:                    initialPieces,
    turn:                      newFirstMover,
    movingPiece:               "",
    visited:                   [],
    lastDir:                   "",
    moveHistory:               [],
    lastTurnHistory:           [],
    lastTurnColor:             "",
    winner:                    null,
    firstMover:                newFirstMover,
    nonFirstMoverHasContinued: false,
    senderColor:               game.senderColor,
    receiverColor:             game.receiverColor,
    timerRunning:              null,
    timerLastTick:             null,
    rematchCount,
    rematch: { status: "accepted", acceptedAt: Date.now() }
  };
  if (msPerPlayer) {
    resetData.timerMaintso = msPerPlayer;
    resetData.timerMena    = msPerPlayer;
  }
  await gameRef.update(resetData);
  return res.status(200).json({ success: true });
}

async function handleDeclineRematch(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "uid and gameId required." });
  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });
  await gameRef.child("rematch").update({ status: "declined", declinedAt: Date.now() });
  return res.status(200).json({ success: true });
}

async function handleMarkRematchDone(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "uid and gameId required." });
  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });
  await gameRef.child("rematch").update({ status: "done" });
  return res.status(200).json({ success: true });
}

async function handleAutoRestart(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "uid and gameId required." });

  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });
  if (!game.winner)
    return res.status(400).json({ error: "No winner yet." });

  if (game.rematch && (game.rematch.status === "auto-restarted" || game.rematch.status === "accepted"))
    return res.status(200).json({ success: true });

  // isCase1: resy ny firstMover → newFirstMover = winner
  // isCase2: mandresy ny GREEN (firstMover=maintso) → newFirstMover = mena (RED)
  // isCase3: mandresy ny RED (firstMover=mena) → tsy azo auto-restart
  const isCase2 = game.firstMover === "maintso" && game.winner === "maintso";
  if (!game.firstMover || (game.winner === game.firstMover && !isCase2))
    return res.status(400).json({ error: "Auto-restart only applies when the phase-1 firstMover lost, or when green (firstMover) won." });

  // isCase1: newFirstMover = non-firstMover teo aloha
  // isCase2: newFirstMover = mena, satria lasa RED no manao hetsika voalohany
  const newFirstMover = isCase2 ? "mena" : (game.winner === "maintso" ? "mena" : "maintso");
  const rematchCount  = (game.rematchCount || 0) + 1;

  const R = ["A","B","C","D","E"], C = ["1","2","3","4","5","6","7","8","9"];
  const initialPieces = {};
  R.forEach((r, ri) => {
    C.forEach((c, ci) => {
      const key = r + c;
      if (ri < 2)      initialPieces[key] = "mena";
      else if (ri > 2) initialPieces[key] = "maintso";
      else {
        if ([1,3,6,8].includes(ci))      initialPieces[key] = "mena";
        else if ([0,2,5,7].includes(ci)) initialPieces[key] = "maintso";
      }
    });
  });

  const minutes     = game.minutes || null;
  const msPerPlayer = minutes ? minutes * 60 * 1000 : null;

  const resetData = {
    pieces:                    initialPieces,
    turn:                      newFirstMover,
    movingPiece:               "",
    visited:                   [],
    lastDir:                   "",
    moveHistory:               [],
    lastTurnHistory:           [],
    lastTurnColor:             "",
    winner:                    null,
    firstMover:                newFirstMover,
    nonFirstMoverHasContinued: false,
    senderColor:               game.senderColor,
    receiverColor:             game.receiverColor,
    timerRunning:              null,
    timerLastTick:             null,
    rematchCount,
    rematch: { status: "auto-restarted", restartedAt: Date.now() }
  };
  if (msPerPlayer) {
    resetData.timerMaintso = msPerPlayer;
    resetData.timerMena    = msPerPlayer;
  }

  await gameRef.update(resetData);
  return res.status(200).json({ success: true });
}

// ── Declare winner ─────────────────────────────────────────────────────────
async function handleDeclareWinner(body, res) {
  const { uid, gameId, winner } = body;
  if (!uid || !gameId || !winner) return res.status(400).json({ error: "uid, gameId, winner required." });
  if (winner !== "maintso" && winner !== "mena") return res.status(400).json({ error: "Invalid winner." });
  const gameRef = gamesRef.child(gameId);
  const game    = await rtdbGet(gameRef);
  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });
  if (game.winner) return res.status(200).json({ success: true, winner: game.winner });
  if (game.minutes) {
    const loser      = winner === "maintso" ? "mena" : "maintso";
    const loserMs    = loser === "maintso" ? (game.timerMaintso || 0) : (game.timerMena || 0);
    const lastTick   = game.timerLastTick || 0;
    const elapsed    = Math.max(0, Date.now() - lastTick);
    const actualLeft = Math.max(0, loserMs - elapsed);
    if (actualLeft > 2000) return res.status(400).json({ error: "Timer not expired yet." });
  }
  await gameRef.update({ winner });
  return res.status(200).json({ success: true, winner });
}

// ── Board helpers ──────────────────────────────────────────────────────────

const ROWS = ["A","B","C","D","E"];
const COLS = ["1","2","3","4","5","6","7","8","9"];

const ALLOWED_MOVES = {
  "A1":["A2","B1","B2"],"A2":["A1","A3","B2"],"A3":["A2","A4","B2","B3","B4"],
  "A4":["A3","A5","B4"],"A5":["A4","A6","B4","B5","B6"],"A6":["A5","A7","B6"],
  "A7":["A6","A8","B6","B7","B8"],"A8":["A7","A9","B8"],"A9":["A8","B8","B9"],
  "B1":["A1","B2","C1"],"B2":["A1","A2","A3","B1","B3","C1","C2","C3"],"B3":["A3","B2","B4","C3"],
  "B4":["A3","A4","A5","B3","B5","C3","C4","C5"],"B5":["A5","B4","B6","C5"],
  "B6":["A5","A6","A7","B5","B7","C5","C6","C7"],
  "B7":["A7","B6","B8","C7"],"B8":["A7","A8","A9","B7","B9","C7","C8","C9"],"B9":["A9","B8","C9"],
  "C1":["B1","B2","C2","D1","D2"],"C2":["B2","C1","C3","D2"],
  "C3":["B2","B3","B4","C2","C4","D2","D3","D4"],
  "C4":["B4","C3","C5","D4"],"C5":["B4","B5","B6","C4","C6","D4","D5","D6"],
  "C6":["B6","C5","C7","D6"],
  "C7":["B6","B7","B8","C6","C8","D6","D7","D8"],"C8":["B8","C7","C9","D8"],
  "C9":["B8","B9","C8","D8","D9"],
  "D1":["C1","D2","E1"],"D2":["C1","C2","C3","D1","D3","E1","E2","E3"],"D3":["C3","D2","D4","E3"],
  "D4":["C3","C4","C5","D3","D5","E3","E4","E5"],"D5":["C5","D4","D6","E5"],
  "D6":["C5","C6","C7","D5","D7","E5","E6","E7"],
  "D7":["C7","D6","D8","E7"],"D8":["C7","C8","C9","D7","D9","E7","E8","E9"],"D9":["C9","D8","E9"],
  "E1":["D1","D2","E2"],"E2":["D2","E1","E3"],"E3":["D2","D3","D4","E2","E4"],
  "E4":["D4","E3","E5"],"E5":["D4","D5","D6","E4","E6"],"E6":["D6","E5","E7"],
  "E7":["D6","D7","D8","E6","E8"],"E8":["D8","E7","E9"],"E9":["D8","D9","E8"]
};

function ph1GetCaptures(pieces, s, e, color) {
  const r1=ROWS.indexOf(s[0]),c1=COLS.indexOf(s[1]),r2=ROWS.indexOf(e[0]),c2=COLS.indexOf(e[1]);
  const enemy=color==="maintso"?"mena":"maintso", dr=r2-r1, dc=c2-c1;
  const scan=(row,col,sr,sc)=>{
    const res=[]; let cr=row+sr, cc=col+sc;
    while(cr>=0&&cr<5&&cc>=0&&cc<9&&pieces[ROWS[cr]+COLS[cc]]===enemy){res.push(ROWS[cr]+COLS[cc]);cr+=sr;cc+=sc;}
    return res;
  };
  return { approach: scan(r2,c2,dr,dc), withdrawal: scan(r1,c1,-dr,-dc) };
}

function ph1PlayerHasAnyCapture(pieces, color) {
  for (const s of Object.keys(pieces)) {
    if (pieces[s] !== color) continue;
    const moves = ALLOWED_MOVES[s] || [];
    for (const t of moves) {
      if (pieces[t]) continue;
      const caps = ph1GetCaptures(pieces, s, t, color);
      if (caps.approach.length > 0 || caps.withdrawal.length > 0) return true;
    }
  }
  return false;
}

function isStillPhase1(pieces, firstMoverColor) {
  const nonFM = firstMoverColor === "maintso" ? "mena" : "maintso";
  return Object.values(pieces).filter(v => v === nonFM).length > 5;
}

function ph2GetCaptures(pieces, s, e, color) {
  const r1=ROWS.indexOf(s[0]),c1=COLS.indexOf(s[1]),r2=ROWS.indexOf(e[0]),c2=COLS.indexOf(e[1]);
  const enemy=color==="maintso"?"mena":"maintso", dr=r2-r1, dc=c2-c1;
  const scan=(row,col,sr,sc)=>{
    const res=[]; let cr=row+sr, cc=col+sc;
    while(cr>=0&&cr<5&&cc>=0&&cc<9&&pieces[ROWS[cr]+COLS[cc]]===enemy){res.push(ROWS[cr]+COLS[cc]);cr+=sr;cc+=sc;}
    return res;
  };
  return { approach: scan(r2,c2,dr,dc), withdrawal: scan(r1,c1,-dr,-dc) };
}

function ph2CheckAvailableCaptures(pieces, s, visited, lastDir, color) {
  const moves = ALLOWED_MOVES[s] || [];
  return moves.some(t => {
    if (pieces[t] || (visited && visited.includes(t))) return false;
    const r1=ROWS.indexOf(s[0]),c1=COLS.indexOf(s[1]),r2=ROWS.indexOf(t[0]),c2=COLS.indexOf(t[1]);
    const dir=`${r2-r1},${c2-c1}`;
    if (lastDir && lastDir === dir) return false;
    const caps = ph2GetCaptures(pieces, s, t, color);
    return (caps.approach.length > 0 || caps.withdrawal.length > 0);
  });
}

function checkGameOver(pieces, timerMaintso, timerMena, minutes) {
  const maintsoCount = Object.values(pieces).filter(v => v === "maintso").length;
  const menaCount    = Object.values(pieces).filter(v => v === "mena").length;
  if (maintsoCount === 0) return "mena";
  if (menaCount    === 0) return "maintso";
  if (minutes) {
    if ((timerMaintso || 0) <= 0) return "mena";
    if ((timerMena    || 0) <= 0) return "maintso";
  }
  return null;
}
