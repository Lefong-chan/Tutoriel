// =============================================================
// dashboard.js — Script principal du tableau de bord Fanorona
// =============================================================

// -------------------------------------------------------------
// SECTION 1 : LOGIQUE UI / ANIMATIONS / INTERACTIONS
// Ce bloc gère l'affichage, les modales, les animations,
// les événements DOM et toute la logique visuelle du dashboard.
// -------------------------------------------------------------

(function () {

  // ── Variables globales ──────────────────────────────────────
  var SESSION_API_URL = '/api/session';
  var AUTH_API_URL = '/api/auth';

  var currentUser = null;
  var activeFriendUid = null;
  var activeFriendName = null;
  var activeCtxTrigger = null;
  var pendingRemoveUid = null;
  var pendingRemoveName = null;
  var upmCurrentUid = null;
  var upmCurrentRelation = null;

  // ── État Room ───────────────────────────────────────────────
  // roomState : null | { role: 'creator'|'guest', game, opponentUid, opponentName, myPret, oppPret, messages[] }
  var roomState = null;
  // inviteTimers : { [friendUid]: intervalId }
  var inviteTimers = {};
  // Invite reçue (côté guest)
  var pendingInviteData = null;
  var inviteCountdownTimer = null;
  // Polling timer pour sync room
  var roomPollTimer = null;

  // ── Éléments DOM ───────────────────────────────────────────
  var loadingOverlay = document.getElementById('loadingOverlay');
  var settingModal = document.getElementById('userSettingModal');
  var profileBox = document.getElementById('profileBox');
  var settingsBtn = document.getElementById('settingsBtn');
  var friendCtxMenu = document.getElementById('friendCtxMenu');
  var userProfileModal = document.getElementById('userProfileModal');
  var removeFriendOverlay = document.getElementById('removeFriendOverlay');

  var toastEl = document.getElementById('toastNotification');
  var toastIconEl = document.getElementById('toastIcon');
  var toastTitleEl = document.getElementById('toastTitle');
  var toastMsgEl = document.getElementById('toastMessage');
  var toastCloseBtn = document.getElementById('toastClose');
  var toastTimeout = null;

  // ── Toast ───────────────────────────────────────────────────
  function showToast(message, type, title) {
    var icons = { error: '✕', success: '✓', info: 'ℹ' };
    var titles = { error: 'Error', success: 'Success', info: 'Info' };
    toastIconEl.textContent = icons[type] || icons.info;
    toastTitleEl.textContent = title || titles[type] || titles.info;
    toastMsgEl.textContent = message;
    toastEl.className = 'toast-notification ' + type + ' show';
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(function () { toastEl.classList.remove('show'); }, 5000);
  }
  toastCloseBtn.addEventListener('click', function () {
    toastEl.classList.remove('show');
    if (toastTimeout) clearTimeout(toastTimeout);
  });

  // ── Helpers ─────────────────────────────────────────────────
  function setPageLoading(on) { loadingOverlay.classList.toggle('active', on); }
  function openModal(modal) { if (modal) modal.classList.add('active'); }
  function closeModal(modal) { if (modal) modal.classList.remove('active'); }
  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function updateUsernameDisplay() {
    var el = document.getElementById('UsernameDisplay');
    if (el) el.textContent = (currentUser && currentUser.username) ? currentUser.username : '____';
  }
  function formatLastSeen(lastSeen) {
    if (!lastSeen) return '';
    var diff = Math.floor((Date.now() - lastSeen) / 1000);
    if (diff < 60) return '';
    var min = Math.floor(diff / 60);
    if (min < 60) return min + 'min ago';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    var days = Math.floor(hr / 24);
    if (days < 365) return days + 'd ago';
    return Math.floor(days / 365) + 'y ago';
  }

  // ── Modal close handlers ────────────────────────────────────
  profileBox.addEventListener('click', function () { if (currentUser) openMyProfileModal(); });
  settingsBtn.addEventListener('click', function () { if (currentUser) openModal(settingModal); });

  document.querySelectorAll('.modal-close-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      var modal = e.target.closest('.modal-overlay');
      if (modal && modal.id !== 'gameSetupModal') closeModal(modal);
    });
  });
  document.querySelectorAll('.modal-overlay').forEach(function (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        if (overlay.id === 'gameSetupModal') { closeGsDropdown(); return; }
        if (overlay === userProfileModal) syncUpmStateToSearch();
        closeModal(overlay);
      }
    });
  });
  document.getElementById('upmCloseBtn').addEventListener('click', function () {
    syncUpmStateToSearch();
    closeModal(userProfileModal);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (userProfileModal.classList.contains('active')) syncUpmStateToSearch();
      document.querySelectorAll('.modal-overlay.active').forEach(function (m) {
        if (m.id === 'gameSetupModal') return;
        closeModal(m);
      });
      closeCtxMenu();
      closeRemoveOverlay();
      closeGsDropdown();
    }
  });

  // ── Set Username ────────────────────────────────────────────
  var setUsernameModal = document.getElementById('setUsernameModal');
  var setUsernameInput = document.getElementById('setUsernameInput');
  var confirmSetUsernameBtn = document.getElementById('confirmSetUsernameBtn');
  var setUsernameError = document.getElementById('setUsernameError');
  var setUsernameLoadingSpinner = document.getElementById('setUsernameLoadingSpinner');

  setUsernameInput.addEventListener('input', function () {
    var val = setUsernameInput.value.trim();
    setUsernameError.style.display = 'none';
    var v = validateUsername(val);
    confirmSetUsernameBtn.disabled = !v.valid;
    if (!v.valid && val.length > 0) { setUsernameError.textContent = v.message; setUsernameError.style.display = 'block'; }
    if (v.valid) {
      clearTimeout(window._uCheck);
      window._uCheck = setTimeout(async function () {
        try {
          var d = await callSessionApi('check-username', { username: val });
          if (!d.available) { setUsernameError.textContent = 'This username is already taken.'; setUsernameError.style.display = 'block'; confirmSetUsernameBtn.disabled = true; }
        } catch (e) {}
      }, 500);
    }
  });
  confirmSetUsernameBtn.addEventListener('click', async function () {
    var u = setUsernameInput.value.trim();
    if (!currentUser || !validateUsername(u).valid) return;
    setUsernameLoadingSpinner.style.display = 'block';
    confirmSetUsernameBtn.disabled = true;
    try {
      var check = await callSessionApi('check-username', { username: u });
      if (!check.available) { setUsernameError.textContent = 'This username is already taken.'; setUsernameError.style.display = 'block'; return; }
      var data = await callSessionApi('set-username', { uid: currentUser.uid, username: u });
      if (data.success && data.user) {
        currentUser = data.user; localStorage.setItem('user', JSON.stringify(currentUser));
        updateUsernameDisplay(); closeModal(setUsernameModal); showToast('Username set!', 'success');
      }
    } catch (err) { setUsernameError.textContent = err.message; setUsernameError.style.display = 'block'; }
    finally { setUsernameLoadingSpinner.style.display = 'none'; confirmSetUsernameBtn.disabled = false; }
  });

  // ── Profile ─────────────────────────────────────────────────
  function openMyProfileModal() {
    var upmUsername = document.getElementById('upmUsername');
    var upmUid = document.getElementById('upmUid');
    var upmRelation = document.getElementById('upmRelationBadge');
    var upmActions = document.getElementById('upmActions');
    upmUsername.textContent = currentUser.username || '____';
    upmUid.textContent = 'UID: ' + (currentUser.uid || '—');
    upmRelation.className = 'upm-relation-badge none';
    upmRelation.innerHTML = '<i class="fas fa-user"></i> My Profile';
    upmActions.innerHTML = '';
    var histBtn = document.createElement('button'); histBtn.className = 'upm-btn upm-btn-history'; histBtn.innerHTML = '<i class="fas fa-history"></i> Game History'; histBtn.addEventListener('click', function () { showToast('Game history coming soon.', 'info'); });
    var flBtn = document.createElement('button'); flBtn.className = 'upm-btn upm-btn-friends-list'; flBtn.innerHTML = '<i class="fas fa-users"></i> My Friends List'; flBtn.addEventListener('click', function () { showToast('Friends list feature coming soon.', 'info'); });
    var emailBtn = document.createElement('button'); emailBtn.className = 'upm-btn'; emailBtn.style.cssText = 'background:#f0f9ff;color:#0369a1;border:1.5px solid #bae6fd;'; emailBtn.innerHTML = '<i class="fas fa-envelope"></i> View My Email'; emailBtn.addEventListener('click', function () { openEmailModal(); });
    upmActions.appendChild(histBtn); upmActions.appendChild(flBtn); upmActions.appendChild(emailBtn);
    openModal(userProfileModal);
  }

  function setUpmLoading(btn, on) { btn.classList.toggle('loading', on); btn.disabled = on; }

  function syncUpmStateToSearch() {
    if (!upmCurrentUid || !upmCurrentRelation) return;
    syncSearchListRelation(upmCurrentUid, upmCurrentRelation);
    upmCurrentUid = null; upmCurrentRelation = null;
  }

  function openUserProfileModal(uid, username, relation) {
    upmCurrentUid = uid; upmCurrentRelation = relation;
    var upmUsername = document.getElementById('upmUsername');
    var upmUid = document.getElementById('upmUid');
    var upmRelation = document.getElementById('upmRelationBadge');
    var upmActions = document.getElementById('upmActions');
    upmUsername.textContent = username;
    upmUid.textContent = 'UID: ' + uid;
    var badgeClass = 'none', badgeHtml = '';
    if (relation === 'friend') { badgeClass = 'friend'; badgeHtml = '<i class="fas fa-user-check"></i> Friends'; }
    else if (relation === 'pending_sent') { badgeClass = 'pending'; badgeHtml = '<i class="fas fa-clock"></i> Request Sent'; }
    else if (relation === 'pending_received') { badgeClass = 'pending'; badgeHtml = '<i class="fas fa-bell"></i> Request Received'; }
    else { badgeHtml = '<i class="fas fa-user"></i> Not Friends'; }
    upmRelation.className = 'upm-relation-badge ' + badgeClass;
    upmRelation.innerHTML = badgeHtml;
    upmActions.innerHTML = '';
    var histBtn = document.createElement('button'); histBtn.className = 'upm-btn upm-btn-history'; histBtn.innerHTML = '<i class="fas fa-history"></i> Game History'; histBtn.addEventListener('click', function () { showToast('Game history coming soon.', 'info'); });
    var flBtn = document.createElement('button'); flBtn.className = 'upm-btn upm-btn-friends-list'; flBtn.innerHTML = '<i class="fas fa-users"></i> Friends List'; flBtn.addEventListener('click', function () { showToast('Friends list feature coming soon.', 'info'); });
    upmActions.appendChild(histBtn); upmActions.appendChild(flBtn);
    if (relation === 'friend') {
      var removeBtn = document.createElement('button'); removeBtn.className = 'upm-btn upm-btn-remove'; removeBtn.innerHTML = '<i class="fas fa-user-times"></i> Remove Friend';
      removeBtn.addEventListener('click', function () { upmCurrentRelation = 'friend'; closeModal(userProfileModal); openRemoveOverlay(uid, username); });
      upmActions.insertBefore(removeBtn, upmActions.children[1]);
    } else if (relation === 'pending_sent') {
      var cancelBtn = document.createElement('button'); cancelBtn.className = 'upm-btn upm-btn-cancel'; cancelBtn.innerHTML = '<i class="fas fa-times-circle"></i> Cancel Request';
      cancelBtn.addEventListener('click', async function () {
        setUpmLoading(cancelBtn, true);
        try {
          await callSessionApi('cancel-friend-request', { uid: currentUser.uid, toUid: uid });
          upmRelation.className = 'upm-relation-badge none'; upmRelation.innerHTML = '<i class="fas fa-user"></i> Not Friends'; upmCurrentRelation = 'none';
          cancelBtn.remove();
          var addB = document.createElement('button'); addB.className = 'upm-btn upm-btn-add'; addB.innerHTML = '<i class="fas fa-user-plus"></i> Add Friend'; addB.addEventListener('click', makeUpmAddHandler(addB, uid, username, upmRelation, upmActions));
          upmActions.insertBefore(addB, upmActions.children[1]); syncSearchListRelation(uid, 'none'); showToast('Friend request cancelled.', 'info'); loadSentPanel();
        } catch (err) { showToast(err.message, 'error'); setUpmLoading(cancelBtn, false); }
      });
      upmActions.insertBefore(cancelBtn, upmActions.children[1]);
    } else if (relation === 'pending_received') {
      var acceptB = document.createElement('button'); acceptB.className = 'upm-btn upm-btn-add'; acceptB.innerHTML = '<i class="fas fa-check-circle"></i> Accept Request';
      acceptB.addEventListener('click', async function () {
        setUpmLoading(acceptB, true);
        try {
          await callSessionApi('accept-friend-request', { uid: currentUser.uid, fromUid: uid });
          upmRelation.className = 'upm-relation-badge friend'; upmRelation.innerHTML = '<i class="fas fa-user-check"></i> Friends'; upmCurrentRelation = 'friend';
          acceptB.remove(); showToast('Friend request accepted!', 'success'); loadFriendsPanel(); loadRequestsPanel();
        } catch (err) { showToast(err.message, 'error'); setUpmLoading(acceptB, false); }
      });
      upmActions.insertBefore(acceptB, upmActions.children[1]);
    } else {
      var addBtn = document.createElement('button'); addBtn.className = 'upm-btn upm-btn-add'; addBtn.innerHTML = '<i class="fas fa-user-plus"></i> Add Friend'; addBtn.addEventListener('click', makeUpmAddHandler(addBtn, uid, username, upmRelation, upmActions));
      upmActions.insertBefore(addBtn, upmActions.children[1]);
    }
    openModal(userProfileModal);
  }

  function makeUpmAddHandler(btn, uid, username, upmRelation, upmActions) {
    return async function () {
      setUpmLoading(btn, true);
      try {
        await callSessionApi('send-friend-request', { uid: currentUser.uid, toUid: uid });
        upmRelation.className = 'upm-relation-badge pending'; upmRelation.innerHTML = '<i class="fas fa-clock"></i> Request Sent'; upmCurrentRelation = 'pending_sent';
        btn.remove();
        var cancelB = document.createElement('button'); cancelB.className = 'upm-btn upm-btn-cancel'; cancelB.innerHTML = '<i class="fas fa-times-circle"></i> Cancel Request';
        cancelB.addEventListener('click', async function () {
          setUpmLoading(cancelB, true);
          try {
            await callSessionApi('cancel-friend-request', { uid: currentUser.uid, toUid: uid });
            upmRelation.className = 'upm-relation-badge none'; upmRelation.innerHTML = '<i class="fas fa-user"></i> Not Friends'; upmCurrentRelation = 'none';
            cancelB.remove();
            var addB2 = document.createElement('button'); addB2.className = 'upm-btn upm-btn-add'; addB2.innerHTML = '<i class="fas fa-user-plus"></i> Add Friend'; addB2.addEventListener('click', makeUpmAddHandler(addB2, uid, username, upmRelation, upmActions));
            upmActions.insertBefore(addB2, upmActions.children[1]); syncSearchListRelation(uid, 'none'); showToast('Friend request cancelled.', 'info'); loadSentPanel();
          } catch (err) { showToast(err.message, 'error'); setUpmLoading(cancelB, false); }
        });
        upmActions.insertBefore(cancelB, upmActions.children[1]); syncSearchListRelation(uid, 'pending_sent'); showToast('Friend request sent!', 'success');
      } catch (err) { showToast(err.message, 'error'); setUpmLoading(btn, false); }
    };
  }

  // ── Remove Friend ────────────────────────────────────────────
  function openRemoveOverlay(uid, name) {
    pendingRemoveUid = uid; pendingRemoveName = name;
    document.getElementById('rmFriendName').textContent = name;
    removeFriendOverlay.classList.add('active');
  }
  function closeRemoveOverlay() {
    removeFriendOverlay.classList.remove('active'); pendingRemoveUid = null; pendingRemoveName = null;
  }
  document.getElementById('rmCancelBtn').addEventListener('click', closeRemoveOverlay);
  removeFriendOverlay.addEventListener('click', function (e) { if (e.target === removeFriendOverlay) closeRemoveOverlay(); });
  document.getElementById('rmConfirmBtn').addEventListener('click', async function () {
    if (!pendingRemoveUid) return;
    var btn = document.getElementById('rmConfirmBtn'); btn.disabled = true;
    try {
      await callSessionApi('remove-friend', { uid: currentUser.uid, friendUid: pendingRemoveUid });
      closeRemoveOverlay(); closeCtxMenu(); showToast('Friend removed.', 'info'); loadFriendsPanel();
    } catch (err) { showToast(err.message, 'error'); } finally { btn.disabled = false; }
  });

  // ── Rename / Logout ──────────────────────────────────────────
  var renameBtn = document.getElementById('renameBtn');
  var renameModal = document.getElementById('renameModal');
  var newNameInput = document.getElementById('newNameInput');
  var passwordConfirmInput = document.getElementById('passwordConfirmInput');
  var confirmRenameBtn = document.getElementById('confirmRenameBtn');
  var usernameError = document.getElementById('UsernameError');
  var passwordErrorMessage = document.getElementById('passwordErrorMessage');
  var renameSuccessMessage = document.getElementById('renameSuccessMessage');
  var renameLoadingSpinner = document.getElementById('renameLoadingSpinner');

  renameBtn.addEventListener('click', function () {
    newNameInput.value = ''; passwordConfirmInput.value = '';
    usernameError.style.display = 'none'; passwordErrorMessage.style.display = 'none'; renameSuccessMessage.style.display = 'none'; confirmRenameBtn.disabled = true;
    openModal(renameModal);
  });
  newNameInput.addEventListener('input', function () {
    var v = validateUsername(newNameInput.value.trim());
    usernameError.style.display = 'none'; confirmRenameBtn.disabled = !(v.valid && passwordConfirmInput.value);
  });
  passwordConfirmInput.addEventListener('input', function () {
    confirmRenameBtn.disabled = !(validateUsername(newNameInput.value.trim()).valid && passwordConfirmInput.value);
  });
  confirmRenameBtn.addEventListener('click', async function () {
    var newUsername = newNameInput.value.trim(); var password = passwordConfirmInput.value;
    if (!password) { passwordErrorMessage.textContent = 'Please enter your password.'; passwordErrorMessage.style.display = 'block'; return; }
    renameLoadingSpinner.style.display = 'block'; confirmRenameBtn.disabled = true; usernameError.style.display = 'none'; passwordErrorMessage.style.display = 'none';
    try {
      var v = await callAuthApi('verify-password', { uid: currentUser.uid, password });
      if (!v.valid) { passwordErrorMessage.textContent = 'Incorrect password.'; passwordErrorMessage.style.display = 'block'; return; }
      var c = await callSessionApi('check-username', { username: newUsername });
      if (!c.available) { usernameError.style.display = 'block'; return; }
      var d = await callSessionApi('set-username', { uid: currentUser.uid, username: newUsername });
      if (d.success) { currentUser = d.user; localStorage.setItem('user', JSON.stringify(currentUser)); updateUsernameDisplay(); renameSuccessMessage.style.display = 'block'; setTimeout(function () { closeModal(renameModal); }, 1500); }
    } catch (err) {
      if (err.message.toLowerCase().includes('taken')) usernameError.style.display = 'block';
      else { passwordErrorMessage.textContent = err.message; passwordErrorMessage.style.display = 'block'; }
    } finally { renameLoadingSpinner.style.display = 'none'; confirmRenameBtn.disabled = false; }
  });

  document.getElementById('signOutBtn').addEventListener('click', function () { openModal(document.getElementById('logoutConfirmModal')); });
  document.getElementById('confirmLogoutBtn').addEventListener('click', function () { localStorage.removeItem('user'); window.location.href = 'login&register.html'; });
  document.getElementById('cancelLogoutBtn').addEventListener('click', function () { closeModal(document.getElementById('logoutConfirmModal')); });

  // ── Friends Modal ────────────────────────────────────────────
  var playersModal = document.getElementById('playersModal');
  document.getElementById('amisBtn').addEventListener('click', function () {
    openModal(playersModal); loadFriendsPanel(); loadRequestsBadge(); loadSentBadge(); updateFooterRequestsBadge(0);
  });
  document.querySelectorAll('.sidebar-item').forEach(function (item) {
    item.addEventListener('click', function () {
      document.querySelectorAll('.sidebar-item').forEach(function (s) { s.classList.remove('active'); });
      item.classList.add('active');
      var pid = item.dataset.panel;
      document.querySelectorAll('.content-panel').forEach(function (p) { p.classList.remove('active-panel'); });
      document.getElementById(pid).classList.add('active-panel');
      if (pid === 'friends-panel') loadFriendsPanel();
      if (pid === 'requests-panel') loadRequestsPanel();
      if (pid === 'sent-panel') loadSentPanel();
      if (pid === 'search-panel') document.getElementById('searchResultsContainer').innerHTML = '';
    });
  });

  function renderEmptyState(container, icon, message) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-' + icon + '"></i><p>' + message + '</p></div>';
  }

  // ── Context Menu ─────────────────────────────────────────────
  function openCtxMenu(triggerBtn, uid, name) {
    activeFriendUid = uid; activeFriendName = name; activeCtxTrigger = triggerBtn;
    var rect = triggerBtn.getBoundingClientRect(); var menuW = 185;
    var left = rect.right - menuW; if (left < 6) left = 6;
    var top = rect.bottom + 5; if (top + 180 > window.innerHeight) top = rect.top - 180;
    friendCtxMenu.style.left = left + 'px'; friendCtxMenu.style.top = top + 'px';
    friendCtxMenu.style.minWidth = menuW + 'px'; friendCtxMenu.classList.add('open');
  }
  function closeCtxMenu() { friendCtxMenu.classList.remove('open'); activeCtxTrigger = null; }
  document.addEventListener('click', function (e) {
    if (!friendCtxMenu.classList.contains('open')) return;
    if (friendCtxMenu.contains(e.target)) return;
    if (activeCtxTrigger && activeCtxTrigger.contains(e.target)) return;
    closeCtxMenu();
  });
  document.getElementById('ctxProfileBtn').addEventListener('click', function () { closeCtxMenu(); openUserProfileModal(activeFriendUid, activeFriendName, 'friend'); });
  document.getElementById('ctxChatBtn').addEventListener('click', function () { closeCtxMenu(); showToast('Chat feature coming soon.', 'info'); });
  document.getElementById('ctxPlayBtn').addEventListener('click', function () { closeCtxMenu(); showToast('Game invite feature coming soon.', 'info'); });
  document.getElementById('ctxRemoveBtn').addEventListener('click', function () { closeCtxMenu(); openRemoveOverlay(activeFriendUid, activeFriendName); });

  // ── UID Copy ─────────────────────────────────────────────────
  var upmCopyUidBtn = document.getElementById('upmCopyUidBtn');
  upmCopyUidBtn.addEventListener('click', function () {
    var uidText = document.getElementById('upmUid').textContent.replace('UID: ', '').trim();
    if (!uidText || uidText === '—') return;
    navigator.clipboard.writeText(uidText).then(function () {
      upmCopyUidBtn.innerHTML = '<i class="fas fa-check"></i>'; upmCopyUidBtn.classList.add('copied');
      setTimeout(function () { upmCopyUidBtn.innerHTML = '<i class="fas fa-copy"></i>'; upmCopyUidBtn.classList.remove('copied'); }, 2000);
    }).catch(function () { showToast('Copy failed.', 'error'); });
  });

  // ── Email Modal ───────────────────────────────────────────────
  var emailModal = document.getElementById('emailModal');
  function openEmailModal() {
    if (!currentUser) return;
    document.getElementById('emailModalUsername').textContent = currentUser.username || '____';
    document.getElementById('emailModalUid').textContent = 'UID: ' + (currentUser.uid || '—');
    document.getElementById('emailModalValue').textContent = currentUser.email || '—';
    openModal(emailModal);
  }
  document.getElementById('emailModalCloseBtn').addEventListener('click', function () { closeModal(emailModal); });
  document.getElementById('emailModalCloseFooterBtn').addEventListener('click', function () { closeModal(emailModal); });
  emailModal.addEventListener('click', function (e) { if (e.target === emailModal) closeModal(emailModal); });

  // ─────────────────────────────────────────────────────────────
  // GAME SELECT MODAL
  // ─────────────────────────────────────────────────────────────
  var gameSelectModal = document.getElementById('gameSelectModal');
  var gameSetupModal = document.getElementById('gameSetupModal');
  var selectedGame = null;
  var selectedColor = 'green';
  var selectedMinutes = 5;
  var gameOrigin = 'create';
  var gsDropdownOpen = false;

  var gameImages = { both: 'img/fanorona&vela.png', fanorona: 'img/fanorona.png', vela: 'img/vela.png' };
  var gameLabels = { both: 'Fanorona & Vela', fanorona: 'Fanorona', vela: 'Vela' };

  function openGameSelectModal(origin) {
    gameOrigin = origin || 'create';
    var isRoom = gameOrigin === 'room';
    document.getElementById('gameSelectTitle').innerHTML = '<i class="fas fa-' + (isRoom ? 'users' : 'gamepad') + '" style="color:#7c3aed;"></i>' + (isRoom ? 'Room' : 'Create a Game');
    document.getElementById('gameSelectSub').textContent = isRoom ? 'Choose the game type for your room' : 'Choose the game type you want to play';
    openModal(gameSelectModal);
  }

  document.getElementById('searchAdversariesBtn').addEventListener('click', function () { openGameSelectModal('create'); });
  document.getElementById('roomBtn').addEventListener('click', function () { openGameSelectModal('room'); });
  document.getElementById('gameSelectCloseBtn').addEventListener('click', function () { closeModal(gameSelectModal); });
  gameSelectModal.addEventListener('click', function (e) { if (e.target === gameSelectModal) closeModal(gameSelectModal); });

  document.querySelectorAll('.game-type-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      selectedGame = btn.dataset.game;
      closeModal(gameSelectModal);
      openGameSetup(selectedGame, gameOrigin);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GAME SETUP MODAL
  // ─────────────────────────────────────────────────────────────
  function openGameSetup(game, origin) {
    var label = gameLabels[game] || game;
    var headerImg = document.getElementById('gsHeaderImg');
    headerImg.innerHTML = '';
    var img = document.createElement('img'); img.src = gameImages[game] || ''; img.alt = label;
    img.onerror = function () { headerImg.innerHTML = '<span class="ph"><i class="fas fa-chess-board"></i></span>'; };
    headerImg.appendChild(img);
    document.getElementById('gsHeaderTitle').textContent = label;

    selectedColor = 'green'; selectedMinutes = 5;
    document.querySelectorAll('.color-pick-btn').forEach(function (b) { b.classList.toggle('selected', b.dataset.color === 'green'); b.classList.remove('disabled-piece'); });
    document.getElementById('gsTimeDisplay').textContent = '5 min';
    document.querySelectorAll('.gs-time-option').forEach(function (o) {
      var is5 = parseInt(o.dataset.minutes) === 5;
      o.classList.toggle('selected', is5);
      var check = o.querySelector('.gs-check'); if (check) check.style.display = is5 ? '' : 'none';
    });
    var trigger = document.getElementById('gsTimeTrigger'); trigger.classList.remove('disabled-ctrl');
    closeGsDropdown();

    // Reset room state
    roomState = null;
    clearAllInviteTimers();
    document.getElementById('gsPlayersSection').style.display = 'none';
    document.getElementById('gsInviteSection').style.display = 'none';
    document.getElementById('gsChatPanel').classList.remove('visible');
    document.getElementById('gsChatMessages').innerHTML = '';

    if (origin === 'room') {
      // Room mode: show invite list, set label, enable "Prêt" logic
      roomState = { role: 'creator', game: game, opponentUid: null, opponentName: null, myPret: true, oppPret: false, messages: [] };
      document.getElementById('gsInviteSection').style.display = 'block';
      setLaunchBtn('pret', true);
      loadInviteFriendsList();
      startRoomPoll();
    } else {
      // Create game mode
      setLaunchBtn('start', false);
    }

    openModal(gameSetupModal);
  }

  // Launch button modes: 'start' | 'pret' | 'not-pret' | 'start-disabled' | 'start-now'
  function setLaunchBtn(mode, isPret) {
    var btn = document.getElementById('gsLaunchBtn');
    var label = document.getElementById('gsLaunchLabel');
    var icon = document.getElementById('gsLaunchIcon');
    btn.className = 'gs-launch-btn';
    btn.disabled = false;

    if (mode === 'pret') {
      btn.classList.add('mode-pret');
      icon.className = 'fas fa-check';
      label.textContent = 'Prêt';
    } else if (mode === 'not-pret') {
      btn.classList.add('mode-not-pret');
      icon.className = 'fas fa-times';
      label.textContent = 'Non Prêt';
    } else if (mode === 'start') {
      btn.classList.add('mode-start');
      icon.className = 'fas fa-play';
      label.textContent = 'Start Game';
    } else if (mode === 'start-disabled') {
      btn.classList.add('mode-start');
      btn.disabled = true;
      icon.className = 'fas fa-play';
      label.textContent = 'Start Game';
    } else if (mode === 'start-now') {
      btn.classList.add('mode-start');
      icon.className = 'fas fa-play';
      label.textContent = 'Start Game';
    }
  }

  document.getElementById('gameSetupBackBtn').addEventListener('click', function () {
    closeGsDropdown();
    stopRoomPoll(); clearAllInviteTimers();
    closeModal(gameSetupModal);
    openGameSelectModal(gameOrigin);
  });
  gameSetupModal.addEventListener('click', function (e) {
    if (e.target === gameSetupModal) closeGsDropdown();
  });

  // Piece selection
  document.querySelectorAll('.color-pick-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (roomState && roomState.role === 'guest') return;
      selectedColor = btn.dataset.color;
      document.querySelectorAll('.color-pick-btn').forEach(function (b) { b.classList.toggle('selected', b.dataset.color === selectedColor); });
    });
  });

  // Launch button click
  document.getElementById('gsLaunchBtn').addEventListener('click', function () {
    if (!roomState) {
      showToast('Game launch coming soon.', 'info');
      return;
    }
    if (roomState.role === 'creator') {
      // Toggle prêt
      roomState.myPret = !roomState.myPret;
      setLaunchBtn(roomState.myPret ? 'pret' : 'not-pret');
      updatePlayersRow();
    } else if (roomState.role === 'guest') {
      // Guest cannot press start
    }
  });

  // ─────────────────────────────────────────────────────────────
  // ROOM — Invite friends list
  // ─────────────────────────────────────────────────────────────
  async function loadInviteFriendsList() {
    var list = document.getElementById('gsInviteList');
    list.innerHTML = '<div class="gs-no-online"><i class="fas fa-spinner fa-spin"></i></div>';
    try {
      var data = await callSessionApi('get-friends', { uid: currentUser.uid });
      list.innerHTML = '';
      var onlineFriends = (data.friends || []).filter(function (f) { return f.online; });
      if (onlineFriends.length === 0) {
        list.innerHTML = '<div class="gs-no-online"><i class="fas fa-user-friends"></i>No friends online</div>';
        return;
      }
      onlineFriends.forEach(function (friend) {
        var div = document.createElement('div'); div.className = 'gs-invite-item';
        div.innerHTML = '<span class="gi-dot"></span><span class="gi-name">' + escapeHtml(friend.username) + '</span>';
        var btn = document.createElement('button');
        btn.className = 'gs-invite-btn send'; btn.dataset.uid = friend.uid; btn.dataset.name = friend.username;
        btn.innerHTML = '<i class="fas fa-paper-plane"></i> Invite';
        btn.addEventListener('click', function () { sendGameInvite(friend.uid, friend.username, btn); });
        div.appendChild(btn); list.appendChild(div);
      });
    } catch (e) {
      list.innerHTML = '<div class="gs-no-online">Failed to load friends.</div>';
    }
  }

  function sendGameInvite(uid, username, btn) {
    if (inviteTimers[uid]) return;
    // Immediately change button to countdown
    var count = 10;
    btn.className = 'gs-invite-btn countdown';
    btn.innerHTML = '<i class="fas fa-clock"></i> ' + count + 's';
    btn.disabled = false;
    btn.onclick = null;

    // Simulate sending invite (store in session via API)
    callSessionApi('send-game-invite', {
      uid: currentUser.uid,
      toUid: uid,
      game: selectedGame,
      senderName: currentUser.username
    }).catch(function () {});

    inviteTimers[uid] = setInterval(function () {
      count--;
      if (count <= 0) {
        clearInterval(inviteTimers[uid]); delete inviteTimers[uid];
        btn.className = 'gs-invite-btn send';
        btn.innerHTML = '<i class="fas fa-paper-plane"></i> Invite';
        btn.disabled = false;
        btn.addEventListener('click', function () { sendGameInvite(uid, username, btn); });
      } else {
        btn.innerHTML = '<i class="fas fa-clock"></i> ' + count + 's';
      }
    }, 1000);
  }

  function clearAllInviteTimers() {
    Object.keys(inviteTimers).forEach(function (uid) { clearInterval(inviteTimers[uid]); });
    inviteTimers = {};
  }

  // ─────────────────────────────────────────────────────────────
  // ROOM — Opponent joined → update UI
  // ─────────────────────────────────────────────────────────────
  function onOpponentJoined(opponentUid, opponentName) {
    if (!roomState) return;
    roomState.opponentUid = opponentUid;
    roomState.opponentName = opponentName;
    roomState.oppPret = false;

    // Hide invite, show players
    document.getElementById('gsInviteSection').style.display = 'none';
    document.getElementById('gsPlayersSection').style.display = 'block';
    document.getElementById('gsChatPanel').classList.add('visible');
    clearAllInviteTimers();

    // Creator stays as prêt by default
    roomState.myPret = true;
    setLaunchBtn('pret');

    // Opponent's piece = opposite of mine
    var oppColor = selectedColor === 'green' ? 'red' : 'green';

    // Disable piece and time for creator too (locked once opponent joins)
    updatePlayersRow();
    updateSetupControlsForRole();
  }

  function updatePlayersRow() {
    var row = document.getElementById('gsPlayersRow');
    if (!roomState || !roomState.opponentUid) return;

    var myName = currentUser.username || 'You';
    var oppName = roomState.opponentName || 'Opponent';
    var myPretHtml = '<span class="gs-player-status ' + (roomState.myPret ? 'pret' : 'not-pret') + '">' + (roomState.myPret ? 'Prêt' : 'Non Prêt') + '</span>';
    var oppPretHtml = '<span class="gs-player-status ' + (roomState.oppPret ? 'pret' : 'not-pret') + '">' + (roomState.oppPret ? 'Prêt' : 'Non Prêt') + '</span>';

    row.innerHTML =
      '<div class="gs-player-card me">' +
        '<div class="gs-player-avatar me"><i class="fas fa-user"></i></div>' +
        '<div class="gs-player-info"><div class="gs-player-name">' + escapeHtml(myName) + '</div><div class="gs-player-role">You — ' + selectedColor + '</div></div>' +
        myPretHtml +
      '</div>' +
      '<div class="gs-player-card opponent">' +
        '<div class="gs-player-avatar opp"><i class="fas fa-user"></i></div>' +
        '<div class="gs-player-info"><div class="gs-player-name">' + escapeHtml(oppName) + '</div><div class="gs-player-role">Opponent — ' + (selectedColor === 'green' ? 'red' : 'green') + '</div></div>' +
        oppPretHtml +
      '</div>';

    // If creator: Start Game enabled only if both prêt
    if (roomState.role === 'creator') {
      if (roomState.myPret && roomState.oppPret) {
        setLaunchBtn('start-now');
      } else {
        setLaunchBtn(roomState.myPret ? 'pret' : 'not-pret');
      }
    }
  }

  function updateSetupControlsForRole() {
    if (!roomState) return;
    var isGuest = roomState.role === 'guest';
    var isCreatorWithOpponent = roomState.role === 'creator' && roomState.opponentUid;

    // Guest: all controls disabled
    if (isGuest) {
      document.querySelectorAll('.color-pick-btn').forEach(function (b) { b.classList.add('disabled-piece'); });
      document.getElementById('gsTimeTrigger').classList.add('disabled-ctrl');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ROOM — Guest side: receive invite
  // ─────────────────────────────────────────────────────────────
  var gameInviteBar = document.getElementById('gameInviteBar');

  function showGameInviteBar(data) {
    pendingInviteData = data;
    document.getElementById('gibTitle').textContent = data.senderName + ' invites you to play';
    document.getElementById('gibSub').textContent = gameLabels[data.game] || data.game;
    gameInviteBar.classList.add('visible');
    var count = 10;
    document.getElementById('gibCountdown').textContent = count + 's';
    if (inviteCountdownTimer) clearInterval(inviteCountdownTimer);
    inviteCountdownTimer = setInterval(function () {
      count--;
      document.getElementById('gibCountdown').textContent = count + 's';
      if (count <= 0) {
        clearInterval(inviteCountdownTimer);
        hideGameInviteBar();
      }
    }, 1000);
  }

  function hideGameInviteBar() {
    gameInviteBar.classList.remove('visible');
    pendingInviteData = null;
    if (inviteCountdownTimer) { clearInterval(inviteCountdownTimer); inviteCountdownTimer = null; }
  }

  document.getElementById('gibDeclineBtn').addEventListener('click', function () {
    if (pendingInviteData) {
      callSessionApi('decline-game-invite', { uid: currentUser.uid, fromUid: pendingInviteData.senderUid }).catch(function () {});
    }
    hideGameInviteBar();
  });

  document.getElementById('gibAcceptBtn').addEventListener('click', function () {
    if (!pendingInviteData) return;
    var data = pendingInviteData;
    hideGameInviteBar();
    // Accept: open setup modal as guest
    selectedGame = data.game;
    gameOrigin = 'room';
    openGameSetupAsGuest(data);
  });

  function openGameSetupAsGuest(inviteData) {
    var label = gameLabels[inviteData.game] || inviteData.game;
    var headerImg = document.getElementById('gsHeaderImg');
    headerImg.innerHTML = '';
    var img = document.createElement('img'); img.src = gameImages[inviteData.game] || ''; img.alt = label;
    img.onerror = function () { headerImg.innerHTML = '<span class="ph"><i class="fas fa-chess-board"></i></span>'; };
    headerImg.appendChild(img);
    document.getElementById('gsHeaderTitle').textContent = label;

    // Opponent's chosen color is opposite of creator's
    // Guest gets the opposite piece: if creator is green → guest is red
    selectedColor = 'red'; // default for guest, will be updated when creator config arrives
    document.querySelectorAll('.color-pick-btn').forEach(function (b) {
      b.classList.toggle('selected', b.dataset.color === selectedColor);
      b.classList.add('disabled-piece');
    });
    document.getElementById('gsTimeTrigger').classList.add('disabled-ctrl');

    document.getElementById('gsInviteSection').style.display = 'none';
    document.getElementById('gsPlayersSection').style.display = 'block';
    document.getElementById('gsChatPanel').classList.add('visible');

    roomState = {
      role: 'guest',
      game: inviteData.game,
      opponentUid: inviteData.senderUid,
      opponentName: inviteData.senderName,
      myPret: true,
      oppPret: true,
      messages: []
    };

    var myName = currentUser.username || 'You';
    var row = document.getElementById('gsPlayersRow');
    row.innerHTML =
      '<div class="gs-player-card opponent">' +
        '<div class="gs-player-avatar opp"><i class="fas fa-user"></i></div>' +
        '<div class="gs-player-info"><div class="gs-player-name">' + escapeHtml(inviteData.senderName) + '</div><div class="gs-player-role">Creator</div></div>' +
        '<span class="gs-player-status pret">Prêt</span>' +
      '</div>' +
      '<div class="gs-player-card me">' +
        '<div class="gs-player-avatar me"><i class="fas fa-user"></i></div>' +
        '<div class="gs-player-info"><div class="gs-player-name">' + escapeHtml(myName) + '</div><div class="gs-player-role">You (Guest)</div></div>' +
        '<span class="gs-player-status pret">Prêt</span>' +
      '</div>';

    // Guest sees "Prêt" button (read-only)
    setLaunchBtn('pret');
    document.getElementById('gsLaunchBtn').disabled = true;

    // Notify creator
    callSessionApi('accept-game-invite', { uid: currentUser.uid, fromUid: inviteData.senderUid, game: inviteData.game }).catch(function () {});
    startRoomPoll();
    openModal(gameSetupModal);
  }

  // ─────────────────────────────────────────────────────────────
  // ROOM — Chat
  // ─────────────────────────────────────────────────────────────
  document.getElementById('gsChatSend').addEventListener('click', function () { sendChatMessage(); });
  document.getElementById('gsChatInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChatMessage(); });

  function sendChatMessage() {
    var input = document.getElementById('gsChatInput');
    var text = input.value.trim(); if (!text) return;
    input.value = '';
    if (!roomState) return;
    appendChatMsg(currentUser.username, text, 'mine');
    callSessionApi('room-chat', {
      uid: currentUser.uid,
      toUid: roomState.opponentUid,
      text: text,
      senderName: currentUser.username
    }).catch(function () {});
  }

  function appendChatMsg(sender, text, side) {
    var msgs = document.getElementById('gsChatMessages');
    var div = document.createElement('div'); div.className = 'gs-chat-msg ' + side;
    if (side === 'theirs') div.innerHTML = '<div class="msg-sender">' + escapeHtml(sender) + '</div>' + escapeHtml(text);
    else div.textContent = text;
    msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
  }

  // ─────────────────────────────────────────────────────────────
  // ROOM — Polling (simulate real-time)
  // ─────────────────────────────────────────────────────────────
  function startRoomPoll() {
    stopRoomPoll();
    roomPollTimer = setInterval(pollRoomState, 3000);
  }
  function stopRoomPoll() {
    if (roomPollTimer) { clearInterval(roomPollTimer); roomPollTimer = null; }
  }

  async function pollRoomState() {
    if (!currentUser || !roomState) return;
    try {
      var data = await callSessionApi('poll-room', { uid: currentUser.uid });
      if (!data) return;

      // Incoming game invite (for non-room users)
      if (data.gameInvite && !roomState) {
        showGameInviteBar(data.gameInvite);
      }

      // Creator: opponent accepted
      if (roomState && roomState.role === 'creator' && !roomState.opponentUid && data.roomGuest) {
        onOpponentJoined(data.roomGuest.uid, data.roomGuest.username);
      }

      // Both sides: sync prêt status
      if (roomState && roomState.opponentUid && data.roomStatus) {
        var prevOppPret = roomState.oppPret;
        roomState.oppPret = data.roomStatus.oppPret;
        if (roomState.role === 'creator') {
          roomState.myPret = data.roomStatus.myPret !== undefined ? data.roomStatus.myPret : roomState.myPret;
          updatePlayersRow();
        }
      }

      // Chat messages
      if (data.chatMessages && data.chatMessages.length) {
        data.chatMessages.forEach(function (msg) {
          appendChatMsg(msg.senderName, msg.text, 'theirs');
        });
      }

      // Decline from opponent (creator's invite was declined)
      if (data.inviteDeclined && roomState && roomState.role === 'creator') {
        var declinedUid = data.inviteDeclined;
        // Reset that invite button
        var list = document.getElementById('gsInviteList');
        var btns = list ? list.querySelectorAll('.gs-invite-btn') : [];
        btns.forEach(function (btn) {
          if (btn.dataset.uid === declinedUid) {
            clearInterval(inviteTimers[declinedUid]); delete inviteTimers[declinedUid];
            btn.className = 'gs-invite-btn declined';
            btn.innerHTML = '<i class="fas fa-times"></i> Décliné';
            setTimeout(function () {
              btn.className = 'gs-invite-btn send'; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Invite';
              btn.disabled = false;
              btn.addEventListener('click', function () { sendGameInvite(declinedUid, btn.closest('.gs-invite-item').querySelector('.gi-name').textContent, btn); });
            }, 2500);
          }
        });
      }

    } catch (e) {}
  }

  // Poll for invites even outside a room
  async function pollForInvites() {
    if (!currentUser || roomState) return;
    try {
      var data = await callSessionApi('poll-room', { uid: currentUser.uid });
      if (data && data.gameInvite) showGameInviteBar(data.gameInvite);
    } catch (e) {}
  }

  // ─────────────────────────────────────────────────────────────
  // TIME DROPDOWN
  // ─────────────────────────────────────────────────────────────
  var gsTimeTrigger = document.getElementById('gsTimeTrigger');
  var gsTimeDropdown = document.getElementById('gsTimeDropdown');
  var gsTimeDropdownOverlay = document.getElementById('gsTimeDropdownOverlay');

  function openGsDropdown() {
    gsDropdownOpen = true;
    gsTimeDropdownOverlay.classList.add('open'); gsTimeDropdown.classList.add('open'); gsTimeTrigger.classList.add('open');
  }
  function closeGsDropdown() {
    gsDropdownOpen = false;
    gsTimeDropdown.classList.remove('open'); gsTimeDropdownOverlay.classList.remove('open');
    if (gsTimeTrigger) gsTimeTrigger.classList.remove('open');
  }
  gsTimeTrigger.addEventListener('click', function (e) {
    e.stopPropagation(); if (gsDropdownOpen) closeGsDropdown(); else openGsDropdown();
  });
  gsTimeDropdownOverlay.addEventListener('click', function (e) { if (e.target === gsTimeDropdownOverlay) closeGsDropdown(); });
  document.querySelectorAll('.gs-time-option').forEach(function (opt) {
    opt.addEventListener('click', function (e) {
      e.stopPropagation(); selectedMinutes = parseInt(opt.dataset.minutes);
      document.getElementById('gsTimeDisplay').textContent = selectedMinutes + ' min';
      document.querySelectorAll('.gs-time-option').forEach(function (o) {
        var sel = parseInt(o.dataset.minutes) === selectedMinutes;
        o.classList.toggle('selected', sel);
        var check = o.querySelector('.gs-check'); if (check) check.style.display = sel ? '' : 'none';
      });
      closeGsDropdown();
    });
  });
  document.addEventListener('click', function (e) {
    if (gsDropdownOpen && gsTimeDropdownOverlay && !gsTimeDropdownOverlay.contains(e.target)) closeGsDropdown();
  });

  // ─────────────────────────────────────────────────────────────
  // SECTION 2 : CONNEXION À L'API (Appels serveur / backend)
  // Ce bloc gère toutes les communications avec le serveur :
  // sessions, authentification, amis, recherche d'utilisateurs,
  // invitations de jeu, synchronisation de room, chat de room.
  // ─────────────────────────────────────────────────────────────

  async function callSessionApi(action, payload) {
    var response = await fetch(SESSION_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, payload))
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Session error. Please try again.');
    return data;
  }

  async function callAuthApi(action, payload) {
    var response = await fetch(AUTH_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, payload))
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Authentication error. Please try again.');
    return data;
  }

  function validateUsername(u) {
    if (u.length < 3 || u.length > 20) return { valid: false, message: 'Username must be 3–20 characters.' };
    if (!/^[a-zA-Z0-9_]+$/.test(u)) return { valid: false, message: 'Only letters, numbers, and underscores.' };
    return { valid: true };
  }

  // ── Session ──────────────────────────────────────────────────
  async function loadSession() {
    setPageLoading(true);
    try {
      var stored = localStorage.getItem('user');
      if (!stored) throw new Error('No session.');
      var local = JSON.parse(stored);
      if (!local || !local.uid) throw new Error('Invalid session.');
      var data = await callSessionApi('get-session', { uid: local.uid });
      if (data.success && data.user) {
        currentUser = data.user; localStorage.setItem('user', JSON.stringify(currentUser));
        updateUsernameDisplay();
        callSessionApi('ping', { uid: currentUser.uid }).catch(function () {});
        setTimeout(loadRequestsBadge, 500);
        if (!currentUser.username) setTimeout(function () { openModal(setUsernameModal); }, 500);
        setInterval(function () {
          if (currentUser) callSessionApi('ping', { uid: currentUser.uid }).catch(function () {});
        }, 30000);
        setInterval(function () {
          if (currentUser && !playersModal.classList.contains('active')) {
            loadRequestsBadge();
            pollForInvites();
          }
          if (currentUser && playersModal.classList.contains('active')) {
            var ap = document.querySelector('.content-panel.active-panel');
            if (ap && ap.id === 'friends-panel') loadFriendsPanel();
          }
        }, 30000);
      } else { throw new Error('Session failed.'); }
    } catch (err) { localStorage.removeItem('user'); window.location.href = 'login&register.html'; }
    finally { setPageLoading(false); }
  }

  // ── Friends panels ───────────────────────────────────────────
  async function loadRequestsBadge() {
    try {
      var data = await callSessionApi('get-friend-requests', { uid: currentUser.uid });
      var count = (data.requests || []).length;
      var badge = document.getElementById('requestsBadge');
      badge.textContent = count; badge.style.display = count > 0 ? 'inline-block' : 'none';
      updateFooterRequestsBadge(count);
    } catch (e) {}
  }
  function updateFooterRequestsBadge(count) {
    var fb = document.getElementById('footerRequestsBadge'); if (!fb) return;
    if (count > 0) { fb.textContent = count > 9 ? '9+' : count; fb.style.display = 'flex'; }
    else { fb.style.display = 'none'; }
  }
  async function loadSentBadge() {
    try {
      var data = await callSessionApi('get-sent-requests', { uid: currentUser.uid });
      var badge = document.getElementById('sentCountBadge');
      var count = data.sentCount || (data.sent || []).length;
      badge.textContent = count; badge.style.display = count > 0 ? 'inline-block' : 'none';
    } catch (e) {}
  }

  async function loadFriendsPanel() {
    var container = document.getElementById('friendsListContainer');
    container.innerHTML = '<div class="spinner-inline"></div>';
    try {
      var data = await callSessionApi('get-friends', { uid: currentUser.uid });
      container.innerHTML = '';
      var countBadge = document.getElementById('friendsCountBadge');
      var friendCount = data.friendCount || 0;
      countBadge.textContent = friendCount + '/100'; countBadge.style.display = friendCount > 0 ? 'inline-block' : 'none';
      if (!data.friends || data.friends.length === 0) { renderEmptyState(container, 'user-friends', 'No friends yet. Use "Add Friend" to get started.'); return; }
      data.friends.forEach(function (friend) {
        var div = document.createElement('div'); div.className = 'player-item';
        var lastSeenTxt = friend.online ? '' : formatLastSeen(friend.lastSeen);
        div.innerHTML =
          '<div class="player-item-left"><i class="fas fa-user-circle user-icon"></i><span class="username">' + escapeHtml(friend.username) + '</span>' +
          (lastSeenTxt ? '<span class="last-seen">' + escapeHtml(lastSeenTxt) + '</span>' : '') +
          '<span class="status-dot ' + (friend.online ? 'online' : 'offline') + '"></span></div>' +
          '<div class="player-item-right"><button class="friend-ctx-btn" data-uid="' + friend.uid + '" data-name="' + escapeHtml(friend.username) + '"><i class="fas fa-ellipsis-v"></i></button></div>';
        div.querySelector('.friend-ctx-btn').addEventListener('click', function (e) {
          e.stopPropagation(); var btn = e.currentTarget;
          if (friendCtxMenu.classList.contains('open') && activeFriendUid === btn.dataset.uid) closeCtxMenu();
          else openCtxMenu(btn, btn.dataset.uid, btn.dataset.name);
        });
        container.appendChild(div);
      });
    } catch (err) { container.innerHTML = ''; renderEmptyState(container, 'exclamation-circle', 'Failed to load friends.'); }
  }

  async function loadRequestsPanel() {
    var container = document.getElementById('requestsListContainer');
    container.innerHTML = '<div class="spinner-inline"></div>';
    try {
      var data = await callSessionApi('get-friend-requests', { uid: currentUser.uid });
      container.innerHTML = '';
      var badge = document.getElementById('requestsBadge');
      if (!data.requests || data.requests.length === 0) { badge.style.display = 'none'; renderEmptyState(container, 'handshake', 'No pending friend requests.'); return; }
      badge.textContent = data.requests.length; badge.style.display = 'inline-block';
      data.requests.forEach(function (req) {
        var div = document.createElement('div'); div.className = 'player-item';
        div.innerHTML = '<div class="player-item-left"><i class="fas fa-user-circle user-icon"></i><span class="username">' + escapeHtml(req.username) + '</span></div>' +
          '<div class="player-item-right"><button class="btn-sm btn-icon btn-accept-icon" data-uid="' + req.uid + '"><i class="fas fa-check"></i></button><button class="btn-sm btn-icon btn-reject-icon" data-uid="' + req.uid + '"><i class="fas fa-times"></i></button></div>';
        var aBtn = div.querySelector('.btn-accept-icon'); var rBtn = div.querySelector('.btn-reject-icon');
        aBtn.addEventListener('click', async function () {
          aBtn.classList.add('loading'); aBtn.disabled = true; rBtn.disabled = true;
          try { await callSessionApi('accept-friend-request', { uid: currentUser.uid, fromUid: aBtn.dataset.uid }); showToast('Friend request accepted!', 'success'); loadRequestsPanel(); loadFriendsPanel(); }
          catch (err) { showToast(err.message, 'error'); aBtn.classList.remove('loading'); aBtn.disabled = false; rBtn.disabled = false; }
        });
        rBtn.addEventListener('click', async function () {
          rBtn.classList.add('loading'); rBtn.disabled = true; aBtn.disabled = true;
          try { await callSessionApi('reject-friend-request', { uid: currentUser.uid, fromUid: rBtn.dataset.uid }); showToast('Declined.', 'info'); loadRequestsPanel(); }
          catch (err) { showToast(err.message, 'error'); rBtn.classList.remove('loading'); rBtn.disabled = false; aBtn.disabled = false; }
        });
        container.appendChild(div);
      });
    } catch (err) { container.innerHTML = ''; renderEmptyState(container, 'exclamation-circle', 'Failed to load requests.'); }
  }

  async function loadSentPanel() {
    var container = document.getElementById('sentListContainer');
    container.innerHTML = '<div class="spinner-inline"></div>';
    try {
      var data = await callSessionApi('get-sent-requests', { uid: currentUser.uid });
      container.innerHTML = '';
      var badge = document.getElementById('sentCountBadge');
      var sentCount = data.sentCount || (data.sent || []).length;
      badge.textContent = sentCount; badge.style.display = sentCount > 0 ? 'inline-block' : 'none';
      if (!data.sent || data.sent.length === 0) { renderEmptyState(container, 'paper-plane', 'No friend requests sent yet.'); return; }
      data.sent.forEach(function (req) {
        var div = document.createElement('div'); div.className = 'player-item';
        div.innerHTML = '<div class="player-item-left"><i class="fas fa-user-circle user-icon"></i><span class="username">' + escapeHtml(req.username) + '</span></div>' +
          '<div class="player-item-right"><button class="btn-sm btn-cancel" data-uid="' + req.uid + '"><i class="fas fa-times"></i> Cancel</button></div>';
        div.querySelector('.btn-cancel').addEventListener('click', async function (e) {
          var btn = e.currentTarget; btn.classList.add('loading'); btn.disabled = true;
          try { await callSessionApi('cancel-friend-request', { uid: currentUser.uid, toUid: btn.dataset.uid }); showToast('Cancelled.', 'info'); loadSentPanel(); }
          catch (err) { showToast(err.message, 'error'); btn.classList.remove('loading'); btn.disabled = false; }
        });
        container.appendChild(div);
      });
    } catch (err) { container.innerHTML = ''; renderEmptyState(container, 'exclamation-circle', 'Failed to load sent requests.'); }
  }

  // ── Search ───────────────────────────────────────────────────
  var searchUserInput = document.getElementById('searchUserInput');
  var searchUserBtn = document.getElementById('searchUserBtn');
  var searchResultsContainer = document.getElementById('searchResultsContainer');
  var searchLoadingSpinner = document.getElementById('searchLoadingSpinner');

  searchUserBtn.addEventListener('click', async function () {
    var query = searchUserInput.value.trim();
    if (query.length < 3) { searchResultsContainer.innerHTML = '<p style="color:#ef4444;font-size:0.88em;padding:4px 0;">Please enter at least 3 characters.</p>'; return; }
    searchLoadingSpinner.style.display = 'block'; searchResultsContainer.innerHTML = '';
    try {
      var data = await callSessionApi('search-users', { uid: currentUser.uid, query });
      searchLoadingSpinner.style.display = 'none';
      if (!data.users || data.users.length === 0) { searchResultsContainer.innerHTML = '<p style="color:#64748b;font-size:0.88em;padding:4px 0;">No players found.</p>'; return; }
      data.users.forEach(function (user) {
        var div = document.createElement('div'); div.className = 'player-item';
        var actionsDiv = document.createElement('div'); actionsDiv.className = 'player-item-right';
        if (user.relation === 'friend') { actionsDiv.innerHTML = '<button class="btn-sm btn-already" disabled><i class="fas fa-user-check"></i> Friends</button>'; }
        else if (user.relation === 'pending_sent') {
          var cb = document.createElement('button'); cb.className = 'btn-sm btn-cancel-req'; cb.dataset.uid = user.uid; cb.innerHTML = '<i class="fas fa-times"></i> Cancel';
          cb.addEventListener('click', makeCancelHandler(cb, user.uid, actionsDiv, user.username));
          actionsDiv.appendChild(cb);
        } else if (user.relation === 'pending_received') {
          var aB = document.createElement('button'); aB.className = 'btn-sm btn-icon btn-accept-icon'; aB.dataset.uid = user.uid; aB.innerHTML = '<i class="fas fa-check"></i>';
          var rB = document.createElement('button'); rB.className = 'btn-sm btn-icon btn-reject-icon'; rB.dataset.uid = user.uid; rB.innerHTML = '<i class="fas fa-times"></i>';
          aB.addEventListener('click', makeAcceptHandler(aB, rB, user.uid, actionsDiv));
          rB.addEventListener('click', makeRejectHandler(aB, rB, user.uid, actionsDiv, user.username));
          actionsDiv.appendChild(aB); actionsDiv.appendChild(rB);
        } else {
          var ab = document.createElement('button'); ab.className = 'btn-sm btn-add'; ab.dataset.uid = user.uid; ab.innerHTML = '<i class="fas fa-user-plus"></i> Add';
          ab.addEventListener('click', makeAddHandler(ab, user.uid, actionsDiv));
          actionsDiv.appendChild(ab);
        }
        var viewBtn = document.createElement('button'); viewBtn.className = 'btn-sm btn-icon'; viewBtn.style.cssText = 'background:#f5f3ff;color:#6C00BF;'; viewBtn.innerHTML = '<i class="fas fa-user"></i>';
        viewBtn.addEventListener('click', (function (uid, username, relation) { return function () { openUserProfileModal(uid, username, relation); }; })(user.uid, user.username, user.relation));
        actionsDiv.insertBefore(viewBtn, actionsDiv.firstChild);
        div.innerHTML = '<div class="player-item-left"><i class="fas fa-user-circle user-icon"></i><span class="username">' + escapeHtml(user.username) + '</span></div>';
        div.appendChild(actionsDiv); searchResultsContainer.appendChild(div);
      });
    } catch (err) { searchLoadingSpinner.style.display = 'none'; searchResultsContainer.innerHTML = '<p style="color:#ef4444;font-size:0.88em;">' + escapeHtml(err.message) + '</p>'; }
  });
  searchUserInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') searchUserBtn.click(); });

  function syncSearchListRelation(uid, newRelation) {
    var items = searchResultsContainer ? searchResultsContainer.querySelectorAll('.player-item') : [];
    items.forEach(function (item) {
      var actionsDiv = item.querySelector('.player-item-right'); if (!actionsDiv) return;
      var btns = actionsDiv.querySelectorAll('[data-uid]'); var match = false;
      btns.forEach(function (b) { if (b.dataset.uid === uid) match = true; }); if (!match) return;
      var username = item.querySelector('.username') ? item.querySelector('.username').textContent : uid;
      actionsDiv.innerHTML = '';
      var viewB = document.createElement('button'); viewB.className = 'btn-sm btn-icon'; viewB.style.cssText = 'background:#f5f3ff;color:#6C00BF;'; viewB.innerHTML = '<i class="fas fa-user"></i>';
      viewB.addEventListener('click', function () { openUserProfileModal(uid, username, newRelation); });
      if (newRelation === 'pending_sent') {
        var cb = document.createElement('button'); cb.className = 'btn-sm btn-cancel-req'; cb.dataset.uid = uid; cb.innerHTML = '<i class="fas fa-times"></i> Cancel';
        cb.addEventListener('click', makeCancelHandler(cb, uid, actionsDiv, username)); actionsDiv.appendChild(viewB); actionsDiv.appendChild(cb);
      } else if (newRelation === 'none') {
        var ab = document.createElement('button'); ab.className = 'btn-sm btn-add'; ab.dataset.uid = uid; ab.innerHTML = '<i class="fas fa-user-plus"></i> Add';
        ab.addEventListener('click', makeAddHandler(ab, uid, actionsDiv)); actionsDiv.appendChild(viewB); actionsDiv.appendChild(ab);
      } else if (newRelation === 'friend') {
        actionsDiv.innerHTML = '<button class="btn-sm btn-already" disabled><i class="fas fa-user-check"></i> Friends</button>';
      }
    });
  }

  function makeAddHandler(btn, uid, actionsDiv) {
    var savedUsername = '';
    try { var pi = btn.closest('.player-item'); if (pi) savedUsername = pi.querySelector('.username').textContent; } catch (e) {}
    return async function () {
      btn.classList.add('loading'); btn.disabled = true;
      try {
        await callSessionApi('send-friend-request', { uid: currentUser.uid, toUid: uid });
        actionsDiv.innerHTML = '';
        var viewB = document.createElement('button'); viewB.className = 'btn-sm btn-icon'; viewB.style.cssText = 'background:#f5f3ff;color:#6C00BF;'; viewB.innerHTML = '<i class="fas fa-user"></i>'; viewB.addEventListener('click', function () { openUserProfileModal(uid, savedUsername, 'pending_sent'); });
        var cb = document.createElement('button'); cb.className = 'btn-sm btn-cancel-req'; cb.dataset.uid = uid; cb.innerHTML = '<i class="fas fa-times"></i> Cancel'; cb.addEventListener('click', makeCancelHandler(cb, uid, actionsDiv, savedUsername));
        actionsDiv.appendChild(viewB); actionsDiv.appendChild(cb); showToast('Friend request sent!', 'success');
      } catch (err) { showToast(err.message, 'error'); btn.classList.remove('loading'); btn.disabled = false; }
    };
  }
  function makeCancelHandler(btn, uid, actionsDiv, savedUsername) {
    return async function () {
      btn.classList.add('loading'); btn.disabled = true;
      var username = savedUsername || '';
      try {
        await callSessionApi('cancel-friend-request', { uid: currentUser.uid, toUid: uid });
        actionsDiv.innerHTML = '';
        var viewB = document.createElement('button'); viewB.className = 'btn-sm btn-icon'; viewB.style.cssText = 'background:#f5f3ff;color:#6C00BF;'; viewB.innerHTML = '<i class="fas fa-user"></i>'; viewB.addEventListener('click', function () { openUserProfileModal(uid, username, 'none'); });
        var ab = document.createElement('button'); ab.className = 'btn-sm btn-add'; ab.dataset.uid = uid; ab.innerHTML = '<i class="fas fa-user-plus"></i> Add'; ab.addEventListener('click', makeAddHandler(ab, uid, actionsDiv));
        actionsDiv.appendChild(viewB); actionsDiv.appendChild(ab); showToast('Cancelled.', 'info'); loadSentPanel();
      } catch (err) { showToast(err.message, 'error'); btn.classList.remove('loading'); btn.disabled = false; }
    };
  }
  function makeAcceptHandler(aBtn, rBtn, uid, actionsDiv) {
    return async function () {
      aBtn.classList.add('loading'); aBtn.disabled = true; rBtn.disabled = true;
      try { await callSessionApi('accept-friend-request', { uid: currentUser.uid, fromUid: uid }); actionsDiv.innerHTML = '<button class="btn-sm btn-already" disabled><i class="fas fa-user-check"></i> Friends</button>'; showToast('Accepted!', 'success'); loadFriendsPanel(); loadRequestsPanel(); }
      catch (err) { showToast(err.message, 'error'); aBtn.classList.remove('loading'); aBtn.disabled = false; rBtn.disabled = false; }
    };
  }
  function makeRejectHandler(aBtn, rBtn, uid, actionsDiv, savedUsername) {
    return async function () {
      rBtn.classList.add('loading'); rBtn.disabled = true; aBtn.disabled = true;
      try {
        await callSessionApi('reject-friend-request', { uid: currentUser.uid, fromUid: uid });
        actionsDiv.innerHTML = '';
        var viewB = document.createElement('button'); viewB.className = 'btn-sm btn-icon'; viewB.style.cssText = 'background:#f5f3ff;color:#6C00BF;'; viewB.innerHTML = '<i class="fas fa-user"></i>'; viewB.addEventListener('click', function () { openUserProfileModal(uid, savedUsername || '', 'none'); });
        var ab = document.createElement('button'); ab.className = 'btn-sm btn-add'; ab.dataset.uid = uid; ab.innerHTML = '<i class="fas fa-user-plus"></i> Add'; ab.addEventListener('click', makeAddHandler(ab, uid, actionsDiv));
        actionsDiv.appendChild(viewB); actionsDiv.appendChild(ab); showToast('Declined.', 'info'); loadRequestsPanel();
      } catch (err) { showToast(err.message, 'error'); rBtn.classList.remove('loading'); rBtn.disabled = false; aBtn.disabled = false; }
    };
  }

  window.showToast = showToast;
  loadSession();
})();
