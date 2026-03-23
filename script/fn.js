  (function () {

    var SESSION_API_URL = '/api/session';
    var GAME_API_URL    = '/api/game-fanorona';

    var FIREBASE_CONFIG = {
      apiKey: "AIzaSyDMr3plGs8sF56pM_O3jYqfGdWTlJiePW0",
      databaseURL: "https://tutoriel-ff487-default-rtdb.firebaseio.com",
      projectId: "tutoriel-ff487",
      appId: "1:128298277579:web:9a7fb395621c448e7f594e",
    };
    firebase.initializeApp(FIREBASE_CONFIG);

    function showError(msg) {
      document.getElementById('error-msg').textContent = msg;
      document.getElementById('error-msg').style.display = 'block';
      document.getElementById('loading-overlay').classList.add('hidden');
    }
    function escapeHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function updateNameFontSize(spanEl, name) {
      var len = name.length;
      var size;
      if (len <= 7)       size = '0.95em';
      else if (len <= 10) size = '0.78em';
      else if (len <= 14) size = '0.62em';
      else                size = '0.50em';
      spanEl.style.fontSize = size;
    }

    function updatePing(ms) {
      var barsEl = document.getElementById('l-ping-bars');
      var msEl   = document.getElementById('l-ping-ms');
      if (!barsEl || !msEl) return;
      var bars = barsEl.querySelectorAll('.pbar');
      var level, colorClass;
      if (ms < 60)       { level = 4; colorClass = 'ping-great'; }
      else if (ms < 150) { level = 3; colorClass = 'ping-good';  }
      else if (ms < 300) { level = 2; colorClass = 'ping-mid';   }
      else               { level = 1; colorClass = 'ping-bad';   }
      bars.forEach(function(bar, i) {
        bar.classList.remove('on', 'ping-bad', 'ping-mid', 'ping-good', 'ping-great');
        if (i < level) bar.classList.add('on', colorClass);
      });
      msEl.textContent = ms + ' ms';
    }
    function measurePing() {
      var t0 = Date.now();
      fetch('/api/session', { method: 'HEAD' })
        .then(function() { updatePing(Date.now() - t0); })
        .catch(function() { updatePing(999); });
    }
    setInterval(measurePing, 4000);
    measurePing();

    var MOVE_TIMER_DURATION = 2.0;
    var SEL_TIMER_DURATION  = 4.0;

    var moveTimerRaf    = null;
    var moveTimerEnd    = null;
    var moveTimerActive = false;

    var selTimerRaf     = null;
    var selTimerEnd     = null;
    var selTimerActive  = false;

    var timerEl = document.getElementById('opp-timer-ls');

    function setTimerDisplay(val) {
      timerEl.textContent = val;
      if (val === '--') {
        timerEl.classList.remove('timer-active', 'timer-urgent');
      } else {
        timerEl.classList.add('timer-active');
        var num = parseFloat(val);
        if (num <= 0.8) timerEl.classList.add('timer-urgent');
        else            timerEl.classList.remove('timer-urgent');
      }
    }

    function stopMoveTimer() {
      if (moveTimerRaf) { cancelAnimationFrame(moveTimerRaf); moveTimerRaf = null; }
      moveTimerActive = false;
      moveTimerEnd    = null;
      if (!selTimerActive) setTimerDisplay('--');
    }

    function startMoveTimer() {
      stopSelTimer(true);
      if (moveTimerRaf) cancelAnimationFrame(moveTimerRaf);
      moveTimerActive = true;
      moveTimerEnd    = Date.now() + MOVE_TIMER_DURATION * 1000;

      function tick() {
        if (!moveTimerActive) return;
        var remaining = (moveTimerEnd - Date.now()) / 1000;
        if (remaining <= 0) {
          setTimerDisplay('0.0');
          moveTimerActive = false;
          moveTimerRaf    = null;
          handleStopBtn();
          return;
        }
        setTimerDisplay(remaining.toFixed(1));
        moveTimerRaf = requestAnimationFrame(tick);
      }
      moveTimerRaf = requestAnimationFrame(tick);
    }

    function stopSelTimer(silent) {
      if (selTimerRaf) { cancelAnimationFrame(selTimerRaf); selTimerRaf = null; }
      selTimerActive = false;
      selTimerEnd    = null;
      if (!silent && !moveTimerActive) setTimerDisplay('--');
    }

    function startSelTimer() {

      if (canChangePiece) return;
      stopMoveTimer();
      if (selTimerRaf) cancelAnimationFrame(selTimerRaf);
      selTimerActive = true;
      selTimerEnd    = Date.now() + SEL_TIMER_DURATION * 1000;

      var returnSpot = localState.movingPiece;

      function tick() {
        if (!selTimerActive) return;
        var remaining = (selTimerEnd - Date.now()) / 1000;
        if (remaining <= 0) {
          setTimerDisplay('0.0');
          selTimerActive = false;
          selTimerRaf    = null;

          autoResolvePending(returnSpot);
          return;
        }
        setTimerDisplay(remaining.toFixed(1));
        selTimerRaf = requestAnimationFrame(tick);
      }
      selTimerRaf = requestAnimationFrame(tick);
    }

    function autoResolvePending(returnSpot) {
      if (!pendingCaptures.moveData) return;
      var md = pendingCaptures.moveData;
      pendingCaptures = { approach: [], withdrawal: [], moveData: null };

      var restoredPieces = Object.assign({}, localState.pieces);

      delete restoredPieces[md.target];
      restoredPieces[md.origin] = myColor;

      var restoredVisited = (localState.visited || []).filter(function(v) { return v !== md.origin; });

      localState.pieces  = restoredPieces;
      localState.visited = restoredVisited;

      selectedSpot = md.origin;

      var piecesSnapshot = Object.assign({}, restoredPieces);

      stopMoveTimer();
      setTimerDisplay('--');

      movingInProgress       = true;
      localState.turn        = myOppColor;
      localState.movingPiece = '';
      localState.visited     = [];
      localState.lastDir     = '';
      selectedSpot           = null;
      lastBlockedSpot        = null;
      canChangePiece         = true;
      document.getElementById('stop-move-btn').classList.remove('active');
      document.getElementById('guides-group').innerHTML = '';
      updateTurnIndicator(localState.turn);
      renderPieces(localState.pieces, localState);

      callApi(GAME_API_URL, 'stop-move', { uid: myUid, gameId: gameId, pieces: piecesSnapshot })
        .catch(function(e) { console.warn('auto-resolve stop-move error', e); });

      var myPCA  = Object.keys(localState.pieces).filter(function(s){ return localState.pieces[s]===myColor; }).length;
      var oppPCA = Object.keys(localState.pieces).filter(function(s){ return localState.pieces[s]===myOppColor; }).length;

    }

    function stopAllTimers() {
      stopSelTimer(true);
      stopMoveTimer();
    }

    var playerTimerEnabled = false;
    var myTimerMs          = 0;
    var oppTimerMs         = 0;
    var timerRunningColor  = null;
    var timerLastTickMs    = null;
    var playerTimerRaf     = null;

    var oppTvalEl = null;
    var myTvalEl  = null;

    function getTimerEls() {
      if (!oppTvalEl) oppTvalEl = document.querySelector('.left-group  .tval');
      if (!myTvalEl)  myTvalEl  = document.querySelector('.right-group .tval');
    }

    function formatPlayerTimer(ms) {
      if (ms <= 0) return '0';
      var totalSec = ms / 1000;
      if (totalSec >= 60) {
        var m = Math.floor(totalSec / 60);
        var s = Math.floor(totalSec % 60);
        return m + ':' + (s < 10 ? '0' : '') + s;
      } else if (totalSec >= 10) {
        return Math.floor(totalSec) + 's';
      } else {
        return totalSec.toFixed(1) + 's';
      }
    }

    function applyTimerUrgency(el, ms) {
      if (!el) return;
      if (ms > 0 && ms <= 10000) el.classList.add('ptimer-urgent');
      else                        el.classList.remove('ptimer-urgent');
    }

    function renderPlayerTimers(myMs, oppMs) {
      getTimerEls();
      if (myTvalEl)  { myTvalEl.textContent  = formatPlayerTimer(myMs);  applyTimerUrgency(myTvalEl,  myMs); }
      if (oppTvalEl) { oppTvalEl.textContent = formatPlayerTimer(oppMs); applyTimerUrgency(oppTvalEl, oppMs); }
    }

    function stopPlayerTimerRaf() {
      if (playerTimerRaf) { cancelAnimationFrame(playerTimerRaf); playerTimerRaf = null; }
    }

    function startPlayerTimerRaf() {
      stopPlayerTimerRaf();
      if (!playerTimerEnabled) return;

      function tick() {
        if (!playerTimerEnabled) return;
        var now     = Date.now();
        var elapsed = timerLastTickMs ? Math.max(0, now - timerLastTickMs) : 0;

        var curMyMs  = myTimerMs;
        var curOppMs = oppTimerMs;

        if (timerRunningColor) {
          if (timerRunningColor === myColor) {

            curMyMs  = Math.max(0, myTimerMs  - elapsed);
          } else {

            curOppMs = Math.max(0, oppTimerMs - elapsed);
          }
        }

        renderPlayerTimers(curMyMs, curOppMs);

        if (timerRunningColor === myColor && curMyMs <= 0) {

          stopPlayerTimerRaf();
          if (!gameOverTriggered) {
            showGameOverAlert(myOppColor, 0);
            callApi(GAME_API_URL, 'declare-winner', { uid: myUid, gameId: gameId, winner: myOppColor })
              .catch(function(e) { console.warn('declare-winner error:', e); });
          }
          return;
        }
        if (timerRunningColor === myOppColor && curOppMs <= 0) {

          stopPlayerTimerRaf();
          if (!gameOverTriggered) {
            showGameOverAlert(myColor, 0);
            callApi(GAME_API_URL, 'declare-winner', { uid: myUid, gameId: gameId, winner: myColor })
              .catch(function(e) { console.warn('declare-winner error:', e); });
          }
          return;
        }

        playerTimerRaf = requestAnimationFrame(tick);
      }
      playerTimerRaf = requestAnimationFrame(tick);
    }

    function onPlayerTimersUpdate(game) {
      if (!game.minutes) return;
      playerTimerEnabled = true;
      getTimerEls();

      var myMs  = myColor === 'maintso' ? (game.timerMaintso || 0) : (game.timerMena || 0);
      var oppMs = myColor === 'maintso' ? (game.timerMena    || 0) : (game.timerMaintso || 0);

      myTimerMs         = myMs;
      oppTimerMs        = oppMs;
      timerRunningColor = game.timerRunning || null;
      timerLastTickMs   = game.timerLastTick || Date.now();

      renderPlayerTimers(myMs, oppMs);

      startPlayerTimerRaf();

      if (!gameOverTriggered) {

      }
    }

    var gameOverTriggered = false;
    function disableBoardCompletely() {
      var board = document.getElementById('game-board');
      if (board) board.classList.add('lock-board');
      var stopBtn = document.getElementById('stop-move-btn');
      if (stopBtn) { stopBtn.classList.remove('active'); stopBtn.style.pointerEvents = 'none'; }
      document.getElementById('guides-group').innerHTML = '';
      document.querySelectorAll('.selected-piece,.movable-piece,.blocked-piece,.capture-target').forEach(function(el) {
        el.removeAttribute('class');
      });
      document.querySelectorAll('.cross-line').forEach(function(el) { el.remove(); });
      stopAllTimers();
      stopPlayerTimerRaf();
    }

    function showGameOverAlert(winnerColor, delayMs) {
      if (gameOverTriggered) return;
      gameOverTriggered = true;

      disableBoardCompletely();

      var delay = (typeof delayMs === 'number') ? delayMs : 2000;

      setTimeout(function() {
        var overlay = document.createElement('div');
        overlay.setAttribute('data-gameover-overlay','1');
        overlay.style.cssText = [
          'position:fixed','inset:0','background:rgba(0,0,0,0.7)',
          'display:flex','justify-content:center','align-items:center',
          'z-index:9999','flex-direction:column','gap:0'
        ].join(';');

        var box = document.createElement('div');
        box.style.cssText = [
          'background:#1a3a5c','border-radius:18px','padding:36px 40px',
          'text-align:center','color:white','font-family:sans-serif',
          'box-shadow:0 8px 40px rgba(0,0,0,0.6)','max-width:320px','width:88vw'
        ].join(';');

        var iWon  = (winnerColor === myColor);
        var myMsg = iWon ? '&#127942; You win!' : '&#128532; You lose!';

        var title = document.createElement('div');
        title.style.cssText = 'font-size:1.6em;font-weight:800;margin-bottom:28px;';
        title.textContent = myMsg;

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:12px;justify-content:center;';

        var btn = document.createElement('button');
        btn.textContent = 'OK';
        btn.style.cssText = [
          'background:#0092FF','color:white','border:none',
          'border-radius:10px','padding:12px 48px',
          'font-size:1.1em','font-weight:700','cursor:pointer',
          'box-shadow:0 2px 10px rgba(0,146,255,0.4)'
        ].join(';');
        btn.onclick = function() { window.location.href = 'dashboard.html'; };
        btnRow.appendChild(btn);

        if (gameSource === 'fanorona') {
          var btnRevanche = document.createElement('button');
          btnRevanche.textContent = 'Restart';
          btnRevanche.style.cssText = [
            'background:#f59e0b','color:white','border:none',
            'border-radius:10px','padding:12px 24px',
            'font-size:1.1em','font-weight:700','cursor:pointer',
            'box-shadow:0 2px 10px rgba(245,158,11,0.4)',
            'min-width:100px','transform:scale(1)'
          ].join(';');
          btnRevanche.addEventListener('mousedown', function(e) { e.currentTarget.style.transform = 'scale(1)'; });
          btnRevanche.onclick = function() {
            btnRevanche.disabled = true;
            callApi(GAME_API_URL, 'request-rematch', { uid: myUid, gameId: gameId })
              .then(function() {
                btnRevanche.textContent = 'Demande envoyée';
                btnRevanche.style.background = '#64748b';
              })
              .catch(function(e) {
                btnRevanche.disabled = false;
                btnRevanche.textContent = 'Restart';
                console.warn('request-rematch error:', e);
              });
          };
          btnRow.appendChild(btnRevanche);
        }

        box.appendChild(title);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
      }, delay);
    }

    async function callApi(url, action, payload) {
      var token = localStorage.getItem('jwtToken') || '';
      var r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(Object.assign({ action: action }, payload))
      });
      if (r.status === 401) { localStorage.removeItem('user'); localStorage.removeItem('jwtToken'); window.location.href = 'login&register.html'; throw new Error('Unauthorized'); }
      var d = await r.json();
      if (!r.ok) throw new Error(d.error || 'API error');
      return d;
    }

    var rows = ['A','B','C','D','E'];
    var cols = ['1','2','3','4','5','6','7','8','9'];

    var allowedMoves = {
      'A1':['A2','B1','B2'],'A2':['A1','A3','B2'],'A3':['A2','A4','B2','B3','B4'],
      'A4':['A3','A5','B4'],'A5':['A4','A6','B4','B5','B6'],'A6':['A5','A7','B6'],
      'A7':['A6','A8','B6','B7','B8'],'A8':['A7','A9','B8'],'A9':['A8','B8','B9'],
      'B1':['A1','B2','C1'],'B2':['A1','A2','A3','B1','B3','C1','C2','C3'],'B3':['A3','B2','B4','C3'],
      'B4':['A3','A4','A5','B3','B5','C3','C4','C5'],'B5':['A5','B4','B6','C5'],
      'B6':['A5','A6','A7','B5','B7','C5','C6','C7'],
      'B7':['A7','B6','B8','C7'],'B8':['A7','A8','A9','B7','B9','C7','C8','C9'],'B9':['A9','B8','C9'],
      'C1':['B1','B2','C2','D1','D2'],'C2':['B2','C1','C3','D2'],
      'C3':['B2','B3','B4','C2','C4','D2','D3','D4'],
      'C4':['B4','C3','C5','D4'],'C5':['B4','B5','B6','C4','C6','D4','D5','D6'],
      'C6':['B6','C5','C7','D6'],
      'C7':['B6','B7','B8','C6','C8','D6','D7','D8'],'C8':['B8','C7','C9','D8'],
      'C9':['B8','B9','C8','D8','D9'],
      'D1':['C1','D2','E1'],'D2':['C1','C2','C3','D1','D3','E1','E2','E3'],'D3':['C3','D2','D4','E3'],
      'D4':['C3','C4','C5','D3','D5','E3','E4','E5'],'D5':['C5','D4','D6','E5'],
      'D6':['C5','C6','C7','D5','D7','E5','E6','E7'],
      'D7':['C7','D6','D8','E7'],'D8':['C7','C8','C9','D7','D9','E7','E8','E9'],'D9':['C9','D8','E9'],
      'E1':['D1','D2','E2'],'E2':['D2','E1','E3'],'E3':['D2','D3','D4','E2','E4'],
      'E4':['D4','E3','E5'],'E5':['D4','D5','D6','E4','E6'],'E6':['D6','E5','E7'],
      'E7':['D6','D7','D8','E6','E8'],'E8':['D8','E7','E9'],'E9':['D8','D9','E8'],
    };

    var myColor    = null;
    var myOppColor = null;
    var gameId     = null;
    var myUid      = null;

    var localState = null;

    var selectedSpot    = null;
    var lastBlockedSpot = null;
    var canChangePiece  = true;
    var pendingCaptures = { approach: [], withdrawal: [], moveData: null };

    var piecesOnBoard = {};

    var moveQueue        = [];
    var movingInProgress = false;

    var myDotEl  = null;
    var oppDotEl = null;

    var params   = new URLSearchParams(window.location.search);
    var gameId_p = params.get('gameId');
    var color_p  = params.get('color');
    var inviteId = params.get('inviteId');
    var gameSource = params.get('source') || 'fanorona';

    async function init() {
      if (!gameId_p || !color_p || !inviteId) { showError('Diso ny fampidirana.'); return; }
      if (color_p !== 'maintso' && color_p !== 'mena') { showError('Diso ny color.'); return; }

      var stored = localStorage.getItem('user');
      if (!stored) { window.location.href = 'login&register.html'; return; }
      var localUser = null;
      try { localUser = JSON.parse(stored); } catch(e) {}
      if (!localUser || !localUser.uid) { window.location.href = 'login&register.html'; return; }

      try {
        var data = await callApi(SESSION_API_URL, 'get-fanorona-game', { uid: localUser.uid, gameId: gameId_p });
        if (!data.success) { showError('Tsy hita ny lalao.'); return; }

        myUid      = localUser.uid;
        gameId     = gameId_p;
        myColor    = color_p;
        myOppColor = color_p === 'maintso' ? 'mena' : 'maintso';

        gameSource = data.source || gameSource || 'fanorona';

        if (gameSource === 'vela') {
          window.location.replace('game-vela.html?gameId=' + encodeURIComponent(gameId_p)
            + '&color=' + encodeURIComponent(color_p)
            + '&inviteId=' + encodeURIComponent(inviteId)
            + '&source=vela');
          return;
        }

        renderPlayersBar(myColor, localUser.username || localUser.uid, data.opponentUsername || '???');

        if (myColor === 'mena') document.getElementById('game-board').classList.add('flipped');

        drawBoardSpots();

        document.getElementById('stop-move-btn').onclick = function() { handleStopBtn(); };

        var d = await callApi(GAME_API_URL, 'get-state', { uid: myUid, gameId: gameId });
        if (d.success) {
          localState = copyState(d.game);
          if (data.opponentUsername && data.opponentUsername !== '???') {
            document.getElementById('loading-overlay').classList.add('hidden');
          }
          applyLocalState();
        }

        startRealtimeListener().catch(function(err) {
          console.error('Realtime listener error:', err);
          showError('Connexion temps réel échouée: ' + err.message);
        });

      } catch(err) { showError('Nisy olana: ' + err.message); }
    }

    function renderPlayersBar(myCol, myUsername, oppUsername) {
      var myDotClass  = myCol === 'maintso' ? 'dot-maintso' : 'dot-mena';
      var oppDotClass = myCol === 'maintso' ? 'dot-mena'    : 'dot-maintso';

      var barTop = document.getElementById('players-bar-top');
      barTop.innerHTML =
        '<div class="player-info">' +
          '<div class="player-dot ' + oppDotClass + '" id="opp-dot"></div>' +
          '<span class="player-name" id="opp-name-span">' + escapeHtml(oppUsername) + '</span>' +
        '</div>';

      var barBottom = document.getElementById('players-bar-bottom');
      barBottom.innerHTML =
        '<div class="player-info">' +
          '<div class="player-dot ' + myDotClass + '" id="my-dot"></div>' +
          '<span class="player-name" id="my-name-span">' + escapeHtml(myUsername) + '</span>' +
        '</div>';

      myDotEl  = document.getElementById('my-dot');
      oppDotEl = document.getElementById('opp-dot');

      updateNameFontSize(document.getElementById('opp-name-span'), oppUsername);
      updateNameFontSize(document.getElementById('my-name-span'),  myUsername);
    }

    function updateTurnIndicator(turn) {
      if (!myDotEl || !oppDotEl) return;
      if (turn === myColor) {
        myDotEl.classList.add('active-turn');   oppDotEl.classList.remove('active-turn');
      } else {
        oppDotEl.classList.add('active-turn');  myDotEl.classList.remove('active-turn');
      }
    }

    var opponentReadyChecked = false;

    async function startRealtimeListener() {
      var tokenData = await callApi(GAME_API_URL, 'get-firebase-token', { uid: myUid, gameId: gameId });
      await firebase.auth().signInWithCustomToken(tokenData.token);

      firebase.database().ref('games/' + gameId).on('value', function(snapshot) {
        var game = snapshot.val();
        if (!game) return;

        if (!opponentReadyChecked &&
            !document.getElementById('loading-overlay').classList.contains('hidden')) {
          var oppUid = (myUid === game.senderUid) ? game.receiverUid : game.senderUid;
          if (oppUid) {
            opponentReadyChecked = true;
            callApi(SESSION_API_URL, 'get-fanorona-game', { uid: myUid, gameId: gameId })
              .then(function(data) {
                if (data.success && data.opponentUsername && data.opponentUsername !== '???') {
                  renderPlayersBar(myColor,
                    (JSON.parse(localStorage.getItem('user') || '{}')).username || myUid,
                    data.opponentUsername);
                  document.getElementById('loading-overlay').classList.add('hidden');
                } else {
                  opponentReadyChecked = false;
                }
              }).catch(function() { opponentReadyChecked = false; });
          }
        }

        if (movingInProgress) {
          if (game.turn !== myColor) {
            movingInProgress = false;
          } else {
            return;
          }
        }

        var prevTurn = localState ? localState.turn : null;
        localState = copyState(game);
        updateTurnIndicator(localState.turn);

        onPlayerTimersUpdate(game);

        if (gameSource === 'fanorona' && game.rematch) {
          var rematchDidReset = handleRematchPush(game.rematch, game);
          if (rematchDidReset) return;
        }

        if (game.winner) {
          stopAllTimers();
          stopPlayerTimerRaf();
          renderPieces(localState.pieces, localState);
          showGameOverAlert(game.winner, 0);
          return;
        }

        if (game.turn !== myColor) {

          stopAllTimers();
          renderPieces(localState.pieces, localState);
          return;
        }

        if (prevTurn === myColor && (selectedSpot || localState.movingPiece)) {
          renderPieces(localState.pieces, localState);
          if (selectedSpot) renderGuides(selectedSpot, localState);
          return;
        }

        canChangePiece  = true;
        selectedSpot    = null;
        lastBlockedSpot = null;
        pendingCaptures = { approach: [], withdrawal: [], moveData: null };
        document.getElementById('guides-group').innerHTML = '';
        document.getElementById('stop-move-btn').classList.remove('active');
        stopAllTimers();
        applyLocalState();
      });
    }

    function copyState(game) {
      return {
        pieces:      Object.assign({}, game.pieces),
        turn:        game.turn,
        movingPiece: game.movingPiece || '',
        visited:     (game.visited || []).slice(),
        lastDir:     game.lastDir || '',
      };
    }

    function applyLocalState() {
      updateTurnIndicator(localState.turn);
      var stopBtn = document.getElementById('stop-move-btn');
      if (localState.turn === myColor && localState.movingPiece) {
        stopBtn.classList.add('active');
      } else if (!movingInProgress) {
        stopBtn.classList.remove('active');
      }
      renderPieces(localState.pieces, localState);
      if (selectedSpot && localState.turn === myColor) {
        renderGuides(selectedSpot, localState);
      }
    }

    function drawBoardSpots() {
      var spotsGrp = document.getElementById('spots-group');
      spotsGrp.innerHTML = '';
      rows.forEach(function(r, ri) {
        cols.forEach(function(c, ci) {
          var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          circle.setAttribute('cx', ci * 50);
          circle.setAttribute('cy', ri * 50);
          circle.setAttribute('r', 18);
          circle.setAttribute('fill', 'transparent');
          circle.setAttribute('class', 'spot');
          (function(spotID) { circle.onclick = function(e) { e.stopPropagation(); handleSpotClick(spotID); }; })(r + c);
          spotsGrp.appendChild(circle);
        });
      });
    }

    function handleSpotClick(spotID) {
      if (!localState || localState.turn !== myColor) return;
      if (pendingCaptures.approach.length > 0 || pendingCaptures.withdrawal.length > 0) return;

      var pieces = localState.pieces;

      if (canChangePiece && pieces[spotID] === myColor) {
        if (canPieceMove(spotID, pieces, myColor, playerHasAnyCapture(pieces, myColor))) {
          selectedSpot    = spotID;
          lastBlockedSpot = null;
        } else {
          selectedSpot    = null;
          lastBlockedSpot = spotID;
        }

        renderGuides(selectedSpot || '', localState);
        renderPieces(pieces, localState);
        return;
      }

      if (!selectedSpot) return;
      if ((allowedMoves[selectedSpot] || []).indexOf(spotID) === -1) return;
      if (pieces[spotID]) return;
      if (localState.visited && localState.visited.indexOf(spotID) !== -1) return;

      var caps = getCaptures(pieces, selectedSpot, spotID, myColor);
      var isCaptureMove = caps.approach.length > 0 || caps.withdrawal.length > 0;
      if (playerHasAnyCapture(pieces, myColor) && !isCaptureMove) return;

      var r1 = rows.indexOf(selectedSpot[0]), c1 = cols.indexOf(selectedSpot[1]);
      var r2 = rows.indexOf(spotID[0]),       c2 = cols.indexOf(spotID[1]);
      var dir = (r2-r1) + ',' + (c2-c1);
      if (!canChangePiece && localState.lastDir === dir) return;

      var origin     = selectedSpot;
      var newPieces  = Object.assign({}, pieces);
      delete newPieces[origin];
      newPieces[spotID] = myColor;
      var newVisited = (localState.visited || []).concat([origin]);

      if (isCaptureMove && caps.approach.length > 0 && caps.withdrawal.length > 0) {
        pendingCaptures = {
          approach:   caps.approach,
          withdrawal: caps.withdrawal,
          moveData:   { origin: origin, target: spotID, dir: dir }
        };
        localState.pieces  = newPieces;
        localState.visited = newVisited;
        selectedSpot = spotID;
        renderPieces(newPieces, localState);
        document.getElementById('guides-group').innerHTML = '';

        startSelTimer();
        return;
      }

      var capturedSpots = isCaptureMove ? caps.approach.concat(caps.withdrawal) : [];
      doMove(origin, spotID, capturedSpots, dir, newVisited, newPieces, isCaptureMove);
    }

    function confirmCapture(type) {
      var md = pendingCaptures.moveData;
      var capturedSpots = type === 'approach' ? pendingCaptures.approach : pendingCaptures.withdrawal;
      pendingCaptures = { approach: [], withdrawal: [], moveData: null };

      stopSelTimer(true);
      var newPieces  = Object.assign({}, localState.pieces);
      var newVisited = (localState.visited || []).slice();
      doMove(md.origin, md.target, capturedSpots, md.dir, newVisited, newPieces, true);
    }

    function doMove(origin, target, capturedSpots, dir, newVisited, newPieces, wasCapture) {
      capturedSpots.forEach(function(s) { delete newPieces[s]; });

      var canContinue = wasCapture && checkAvailableCaptures(newPieces, target, newVisited, dir, myColor);

      movingInProgress = true;
      localState.pieces = newPieces;

      if (canContinue) {
        localState.movingPiece = target;
        localState.visited     = newVisited;
        localState.lastDir     = dir;
        selectedSpot   = target;
        canChangePiece = false;
        document.getElementById('stop-move-btn').classList.add('active');

        startMoveTimer();
      } else {
        localState.turn        = myOppColor;
        localState.movingPiece = '';
        localState.visited     = [];
        localState.lastDir     = '';
        selectedSpot    = null;
        lastBlockedSpot = null;
        canChangePiece  = true;
        document.getElementById('stop-move-btn').classList.remove('active');

        stopAllTimers();
      }

      if (canContinue && selectedSpot) {
        renderGuides(selectedSpot, localState);
      } else {
        document.getElementById('guides-group').innerHTML = '';
      }

      updateTurnIndicator(localState.turn);
      renderPieces(localState.pieces, localState);

      sendMoveToBackend(origin, target, capturedSpots, dir);
    }

    function handleStopBtn() {
      if (!localState || localState.turn !== myColor || !localState.movingPiece) return;
      var piecesSnapshot = Object.assign({}, localState.pieces);

      stopAllTimers();

      movingInProgress = true;
      localState.turn        = myOppColor;
      localState.movingPiece = '';
      localState.visited     = [];
      localState.lastDir     = '';
      selectedSpot    = null;
      lastBlockedSpot = null;
      canChangePiece  = true;
      document.getElementById('stop-move-btn').classList.remove('active');
      document.getElementById('guides-group').innerHTML = '';
      updateTurnIndicator(localState.turn);
      renderPieces(localState.pieces, localState);

      callApi(GAME_API_URL, 'stop-move', { uid: myUid, gameId: gameId, pieces: piecesSnapshot })
        .catch(function(e) { console.warn('stop-move error', e); });

    }

    function sendMoveToBackend(origin, target, capturedSpots, dir) {
      callApi(GAME_API_URL, 'make-move', {
        uid: myUid, gameId: gameId,
        origin: origin, target: target,
        capturedSpots: capturedSpots, dir: dir
      }).catch(function(e) {
        console.warn('make-move backend error (non-blocking):', e);
      });
    }

    function renderPieces(pieces, stateData) {
      var grp           = document.getElementById('pieces-group');
      var isMyTurn      = stateData.turn === myColor;
      var globalCapture = playerHasAnyCapture(pieces, myColor);

      var newPiecesOnBoard = {};
      var vanished = Object.keys(piecesOnBoard).filter(function(k) { return !pieces[k]; });
      var appeared = Object.keys(pieces).filter(function(k) { return !piecesOnBoard[k]; });

      vanished.forEach(function(vKey) {
        var color  = piecesOnBoard[vKey].color;
        var target = null;
        for (var i = 0; i < appeared.length; i++) {
          if (pieces[appeared[i]] === color) { target = appeared[i]; break; }
        }
        if (target) {
          var entry = piecesOnBoard[vKey];

          entry.el.classList.remove('no-transition');
          newPiecesOnBoard[target] = entry;
          appeared = appeared.filter(function(a) { return a !== target; });
        } else {
          piecesOnBoard[vKey].el.remove();
        }
      });

      appeared.forEach(function(aKey) {
        var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

        g.setAttribute('class', 'piece-group no-transition');
        var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('r', 8);
        g.appendChild(c);
        grp.appendChild(g);
        newPiecesOnBoard[aKey] = { el: g, color: pieces[aKey] };
      });

      (function(snapAppeared, snapBoard) {
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            snapAppeared.forEach(function(aKey) {
              if (snapBoard[aKey] && snapBoard[aKey].el) {
                snapBoard[aKey].el.classList.remove('no-transition');
              }
            });
          });
        });
      })(appeared.slice(), newPiecesOnBoard);

      Object.keys(pieces).forEach(function(k) {
        if (!newPiecesOnBoard[k]) newPiecesOnBoard[k] = piecesOnBoard[k];
      });
      piecesOnBoard = newPiecesOnBoard;

      var hasPending = pendingCaptures.approach.length > 0 || pendingCaptures.withdrawal.length > 0;

      Object.keys(pieces).forEach(function(spot) {
        var ri = rows.indexOf(spot[0]), ci = cols.indexOf(spot[1]);
        if (ri < 0 || ci < 0) return;
        var entry = piecesOnBoard[spot];
        if (!entry) return;
        var g = entry.el, circle = g.querySelector('circle');

        var svgX = ci * 50;
        var svgY = ri * 50;
        g.setAttribute('transform', 'translate(' + svgX + ',' + svgY + ')');
        circle.setAttribute('fill', 'url(#' + pieces[spot] + '-pat)');
        circle.removeAttribute('class');
        circle.style.pointerEvents = 'all';
        circle.onclick = (function(s) {
          return function(e) { e.stopPropagation(); handleSpotClick(s); };
        })(spot);

        if (isMyTurn && pieces[spot] === myColor) {
          if (selectedSpot === spot)
            circle.setAttribute('class', 'selected-piece');
          else if (lastBlockedSpot === spot)
            circle.setAttribute('class', 'blocked-piece');
          else if (!stateData.movingPiece && canPieceMove(spot, pieces, myColor, globalCapture))
            circle.setAttribute('class', 'movable-piece');
        }

        var isApp  = pendingCaptures.approach.indexOf(spot)   !== -1;
        var isWith = pendingCaptures.withdrawal.indexOf(spot) !== -1;
        g.querySelectorAll('.cross-line').forEach(function(l) { l.remove(); });

        if (isApp || isWith) {
          circle.classList.add('capture-target');
          circle.style.pointerEvents = 'all';
          var ct = isApp ? 'approach' : 'withdrawal';
          circle.onclick = (function(type) {
            return function(e) { e.stopPropagation(); confirmCapture(type); };
          })(ct);
          g.appendChild(createCross(-5,-5,5,5));
          g.appendChild(createCross(5,-5,-5,5));
        }
      });

      var board = document.getElementById('game-board');
      if (!isMyTurn || hasPending) board.classList.add('lock-board');
      else board.classList.remove('lock-board');
    }

    function createCross(x1,y1,x2,y2) {
      var l = document.createElementNS('http://www.w3.org/2000/svg','line');
      l.setAttribute('x1',x1); l.setAttribute('y1',y1);
      l.setAttribute('x2',x2); l.setAttribute('y2',y2);
      l.setAttribute('class','cross-line');
      return l;
    }

    function renderGuides(startSpot, stateData) {
      var grp = document.getElementById('guides-group');
      if (!grp) return;
      grp.innerHTML = '';
      if (!startSpot) return;

      var pieces  = stateData.pieces;
      var visited = stateData.visited  || [];
      var lastDir = stateData.lastDir  || '';
      var globalCapturePossible = playerHasAnyCapture(pieces, myColor);
      var moves = allowedMoves[startSpot] || [];

      moves.forEach(function(target) {
        if (pieces[target] || visited.indexOf(target) !== -1) return;
        var caps = getCaptures(pieces, startSpot, target, myColor);
        var isCaptureMove = caps.approach.length > 0 || caps.withdrawal.length > 0;
        if (globalCapturePossible && !isCaptureMove) return;

        var r1 = rows.indexOf(startSpot[0]), c1 = cols.indexOf(startSpot[1]);
        var r2 = rows.indexOf(target[0]),    c2 = cols.indexOf(target[1]);
        var dir = (r2-r1) + ',' + (c2-c1);
        if (!canChangePiece && lastDir === dir) return;

        var svgX = c2 * 50;
        var svgY = r2 * 50;

        var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', svgX); dot.setAttribute('cy', svgY);
        dot.setAttribute('r', 6); dot.setAttribute('class', 'guide-dot');
        grp.appendChild(dot);
      });
    }

    function getCaptures(pieces, s, e, color) {
      var r1=rows.indexOf(s[0]),c1=cols.indexOf(s[1]),r2=rows.indexOf(e[0]),c2=cols.indexOf(e[1]);
      var enemy=color==='maintso'?'mena':'maintso', dr=r2-r1, dc=c2-c1;
      function scan(row,col,sr,sc) {
        var res=[],cr=row+sr,cc=col+sc;
        while(cr>=0&&cr<5&&cc>=0&&cc<9&&pieces[rows[cr]+cols[cc]]===enemy){res.push(rows[cr]+cols[cc]);cr+=sr;cc+=sc;}
        return res;
      }
      return { approach: scan(r2,c2,dr,dc), withdrawal: scan(r1,c1,-dr,-dc) };
    }

    function playerHasAnyCapture(pieces, color) {
      var sl = Object.keys(pieces);
      for (var i=0;i<sl.length;i++) {
        var s=sl[i]; if(pieces[s]!==color)continue;
        var mv=allowedMoves[s]||[];
        for (var j=0;j<mv.length;j++) {
          var t=mv[j]; if(!pieces[t]){var c=getCaptures(pieces,s,t,color);if(c.approach.length>0||c.withdrawal.length>0)return true;}
        }
      }
      return false;
    }

    function canPieceMove(spot, pieces, color, globalCapture) {
      var mv=allowedMoves[spot]||[];
      for(var i=0;i<mv.length;i++){
        var t=mv[i]; if(pieces[t])continue;
        var caps=getCaptures(pieces,spot,t,color);
        var isCap=caps.approach.length>0||caps.withdrawal.length>0;
        if(globalCapture?isCap:true)return true;
      }
      return false;
    }

    function checkAvailableCaptures(pieces, s, visited, lastDir, color) {
      var mv=allowedMoves[s]||[];
      for(var i=0;i<mv.length;i++){
        var t=mv[i];
        if(pieces[t]||(visited&&visited.indexOf(t)!==-1))continue;
        var r1=rows.indexOf(s[0]),c1=cols.indexOf(s[1]),r2=rows.indexOf(t[0]),c2=cols.indexOf(t[1]);
        var dir=(r2-r1)+','+(c2-c1);
        if(lastDir&&lastDir===dir)continue;
        var caps=getCaptures(pieces,s,t,color);
        if(caps.approach.length>0||caps.withdrawal.length>0)return true;
      }
      return false;
    }

    var rematchHandled   = false;
    var rematchResetDone = false;
    var rematchOverlayEl = null;

    var rnCountdownTimer = null;
    var rnCountdownVal   = 10;

    function showRematchNotif(oppUsername) {
      var notif      = document.getElementById('rematch-notif');
      var progressBar = document.getElementById('rnProgressBar');
      var countdownEl = document.getElementById('rn-countdown');
      var usernameEl  = document.getElementById('rn-username');
      if (!notif) return;

      usernameEl.textContent = oppUsername || 'Adversaire';
      countdownEl.textContent = '10';
      rnCountdownVal = 10;

      notif.classList.remove('rn-expanded', 'rn-visible');
      progressBar.style.transition = 'none';
      progressBar.style.transform  = 'scaleX(1)';

      setTimeout(function() {
        notif.classList.add('rn-visible');
        setTimeout(function() {
          notif.classList.add('rn-expanded');
          void progressBar.offsetHeight;
          progressBar.style.transition = 'transform 10s linear';
          progressBar.style.transform  = 'scaleX(0)';
        }, 350);
      }, 10);

      if (rnCountdownTimer) clearInterval(rnCountdownTimer);
      rnCountdownTimer = setInterval(function() {
        rnCountdownVal--;
        countdownEl.textContent = rnCountdownVal;
        if (rnCountdownVal <= 0) {
          clearInterval(rnCountdownTimer);
          hideRematchNotif();

          callApi(GAME_API_URL, 'decline-rematch', { uid: myUid, gameId: gameId })
            .catch(function(e) { console.warn('auto-decline rematch:', e); });
          rematchHandled = false;
        }
      }, 1000);
    }

    function hideRematchNotif() {
      var notif = document.getElementById('rematch-notif');
      if (notif) notif.classList.remove('rn-visible', 'rn-expanded');
      if (rnCountdownTimer) { clearInterval(rnCountdownTimer); rnCountdownTimer = null; }
    }

    function handleRematchPush(rematch, game) {
      if (!rematch) return false;

      if (rematch.status === 'accepted') {
        if (rematchResetDone) return true;
        rematchResetDone = true;
        rematchHandled   = false;
        hideRematchNotif();
        resetGameForRematch(game);

        callApi(GAME_API_URL, 'mark-rematch-done', { uid: myUid, gameId: gameId })
          .catch(function(e) { console.warn('mark-rematch-done error:', e); });
        return true;
      }

      if (rematch.status === 'pending' && rematch.requestedBy !== myUid) {
        if (rematchHandled) return false;
        rematchHandled = true;
        var oppName = myColor === 'maintso'
          ? (game.receiverUsername || 'Adversaire')
          : (game.senderUsername   || 'Adversaire');
        showRematchNotif(oppName);
        document.getElementById('rematch-accept-btn').onclick = function() {
          hideRematchNotif();
          callApi(GAME_API_URL, 'accept-rematch', { uid: myUid, gameId: gameId })
            .catch(function(e) { console.warn('accept-rematch error:', e); });
        };
        document.getElementById('rematch-decline-btn').onclick = function() {
          hideRematchNotif();
          callApi(GAME_API_URL, 'decline-rematch', { uid: myUid, gameId: gameId })
            .catch(function(e) { console.warn('decline-rematch error:', e); });
          rematchHandled = false;
        };
        return false;
      }

      if (rematch.status === 'declined') {
        hideRematchNotif();
        rematchHandled = false;
      }
      if (rematch.status === 'done') {
        rematchHandled   = false;
        rematchResetDone = false;
      }
      return false;
    }

    function resetGameForRematch(game) {
      stopAllTimers();
      stopPlayerTimerRaf();

      var board = document.getElementById('game-board');
      if (myColor === 'mena') board.classList.add('flipped');
      else                    board.classList.remove('flipped');

      gameOverTriggered = false;
      movingInProgress  = false;
      selectedSpot      = null;
      lastBlockedSpot   = null;
      canChangePiece    = true;
      pendingCaptures   = { approach: [], withdrawal: [], moveData: null };
      piecesOnBoard     = {};

      playerTimerEnabled = false;
      myTimerMs  = 0; oppTimerMs = 0;
      timerRunningColor = null; timerLastTickMs = null;

      var piecesGrp = document.getElementById('pieces-group');
      if (piecesGrp) piecesGrp.innerHTML = '';

      document.getElementById('guides-group').innerHTML = '';
      document.getElementById('stop-move-btn').classList.remove('active');
      document.getElementById('stop-move-btn').style.pointerEvents = '';
      document.querySelectorAll('[data-gameover-overlay]').forEach(function(el) { el.remove(); });
      var board2 = document.getElementById('game-board');
      if (board2) board2.classList.remove('lock-board');

      drawBoardSpots();

      var localUser = JSON.parse(localStorage.getItem('user') || '{}');
      callApi(SESSION_API_URL, 'get-fanorona-game', { uid: myUid, gameId: gameId })
        .then(function(d) {
          renderPlayersBar(myColor, localUser.username || myUid, d.opponentUsername || '???');
        }).catch(function() {});

      localState = copyState(game);
      onPlayerTimersUpdate(game);
      applyLocalState();
    }

    init();

  })();
