// =============================================================
// dashboard.js
// =============================================================
(function () {
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

  function showToast(msg, type, title) {
    var icons = { error: '✕', success: '✓', info: 'ℹ' };
    var titles = { error: 'Error', success: 'Success', info: 'Info' };
    toastIconEl.textContent = icons[type] || icons.info;
    toastTitleEl.textContent = title || titles[type] || titles.info;
    toastMsgEl.textContent = msg;
    toastEl.className = 'toast-notification ' + type + ' show';
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(function () { toastEl.classList.remove('show'); }, 5000);
  }
  toastCloseBtn.addEventListener('click', function () { toastEl.classList.remove('show'); if (toastTimeout) clearTimeout(toastTimeout); });

  function setPageLoading(on) { loadingOverlay.classList.toggle('active', on); }
  function openModal(m) { if (m) m.classList.add('active'); }
  function closeModal(m) { if (m) m.classList.remove('active'); }

  function updateUsernameDisplay() {
    var el = document.getElementById('UsernameDisplay');
    if (el) el.textContent = (currentUser && currentUser.username) ? currentUser.username : '____';
  }

  async function callSessionApi(action, payload) {
    var r = await fetch(SESSION_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ action }, payload)) });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Session error.');
    return d;
  }
  async function callAuthApi(action, payload) {
    var r = await fetch(AUTH_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ action }, payload)) });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Auth error.');
    return d;
  }

  async function loadSession() {
    setPageLoading(true);
    try {
      var stored = localStorage.getItem('user');
      if (!stored) throw new Error('No session.');
      var local = JSON.parse(stored);
      if (!local || !local.uid) throw new Error('Invalid session.');
      var data = await callSessionApi('get-session', { uid: local.uid });
      if (data.success && data.user) {
        currentUser = data.user;
        localStorage.setItem('user', JSON.stringify(currentUser));
        updateUsernameDisplay();
        callSessionApi('ping', { uid: currentUser.uid }).catch(function(){});
        setTimeout(loadRequestsBadge, 500);
        if (!currentUser.username) setTimeout(function () { openModal(document.getElementById('setUsernameModal')); }, 500);
        setInterval(function () { if (currentUser) callSessionApi('ping', { uid: currentUser.uid }).catch(function(){}); }, 10000);
        setInterval(function () {
          if (currentUser && !playersModal.classList.contains('active')) loadRequestsBadge();
          if (currentUser && playersModal.classList.contains('active')) {
            var ap = document.querySelector('.content-panel.active-panel');
            if (ap && ap.id === 'friends-panel') loadFriendsPanel();
          }
        }, 8000);
        // Démarrer le polling des invitations de jeu (toutes les 3s)
        startGameInvitePolling();
      } else throw new Error('Session failed.');
    } catch (err) { localStorage.removeItem('user'); window.location.href = 'login&register.html'; }
    finally { setPageLoading(false); }
  }

  function validateUsername(u) {
    if (u.length < 3 || u.length > 20) return { valid: false, message: 'Username must be 3–20 characters.' };
    if (!/^[a-zA-Z0-9_]+$/.test(u)) return { valid: false, message: 'Only letters, numbers, and underscores are allowed.' };
    return { valid: true };
  }
  function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // ── Username setup ──────────────────────────────────────────
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
        try { var d = await callSessionApi('check-username', { username: val }); if (!d.available) { setUsernameError.textContent = 'This username is already taken.'; setUsernameError.style.display = 'block'; confirmSetUsernameBtn.disabled = true; } } catch (e) {}
      }, 500);
    }
  });
  confirmSetUsernameBtn.addEventListener('click', async function () {
    var u = setUsernameInput.value.trim();
    if (!currentUser || !validateUsername(u).valid) return;
    setUsernameLoadingSpinner.style.display = 'block'; confirmSetUsernameBtn.disabled = true;
    try {
      var check = await callSessionApi('check-username', { username: u });
      if (!check.available) { setUsernameError.textContent = 'This username is already taken.'; setUsernameError.style.display = 'block'; return; }
      var data = await callSessionApi('set-username', { uid: currentUser.uid, username: u });
      if (data.success && data.user) { currentUser = data.user; localStorage.setItem('user', JSON.stringify(currentUser)); updateUsernameDisplay(); closeModal(setUsernameModal); showToast('Username set successfully!', 'success'); }
    } catch (err) { if (!err.message.includes('taken')) { setUsernameError.textContent = err.message; setUsernameError.style.display = 'block'; } }
    finally { setUsernameLoadingSpinner.style.display = 'none'; confirmSetUsernameBtn.disabled = false; }
  });

  profileBox.addEventListener('click', function () { if (currentUser) openMyProfileModal(); });
  settingsBtn.addEventListener('click', function () { if (currentUser) openModal(settingModal); });

  document.querySelectorAll('.modal-close-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) { var m = e.target.closest('.modal-overlay'); if (m) closeModal(m); });
  });
  document.querySelectorAll('.modal-overlay').forEach(function (o) {
    o.addEventListener('click', function (e) {
      if (e.target !== o) return;
      if (o.id === 'gameSetupModal' || o.id === 'inviteFriendsModal') return;
      // Room+matchup: bloquer fermeture gameSelectModal par clic extérieur
      if (o.id === 'gameSelectModal' && gameOrigin === 'room' && matchupData) return;
      if (o === userProfileModal) syncUpmStateToSearch();
      closeModal(o);
    });
  });
  document.getElementById('upmCloseBtn').addEventListener('click', function () { syncUpmStateToSearch(); closeModal(userProfileModal); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (userProfileModal.classList.contains('active')) syncUpmStateToSearch();
      document.querySelectorAll('.modal-overlay.active').forEach(function (m) {
        if (m.id === 'gameSetupModal' || m.id === 'inviteFriendsModal') return;
        // Bloquer fermeture gameSelectModal si room avec matchup
        if (m.id === 'gameSelectModal' && gameOrigin === 'room' && matchupData) return;
        closeModal(m);
      });
      closeCtxMenu(); closeRemoveOverlay();
    }
  });

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
    var hBtn = document.createElement('button'); hBtn.className = 'upm-btn upm-btn-history'; hBtn.innerHTML = '<i class="fas fa-history"></i> Game History'; hBtn.addEventListener('click', function () { showToast('Game history coming soon.', 'info'); });
    var fBtn = document.createElement('button'); fBtn.className = 'upm-btn upm-btn-friends-list'; fBtn.innerHTML = '<i class="fas fa-users"></i> My Friends List';
    fBtn.addEventListener('click', function () {
      closeModal(userProfileModal);
      // Ouvrir playersModal sur l'onglet friends
      _friendsFirstLoad = true;
      document.querySelectorAll('.sidebar-item').forEach(function(s){ s.classList.remove('active'); });
      var fsi = document.querySelector('.sidebar-item[data-panel="friends-panel"]');
      if (fsi) fsi.classList.add('active');
      document.querySelectorAll('.content-panel').forEach(function(p){ p.classList.remove('active-panel'); });
      document.getElementById('friends-panel').classList.add('active-panel');
      openModal(playersModal);
      loadFriendsPanel(); loadRequestsBadge(); loadSentBadge();
    });
    var eBtn = document.createElement('button'); eBtn.className = 'upm-btn'; eBtn.style.cssText = 'background:#f0f9ff;color:#0369a1;border:1.5px solid #bae6fd;'; eBtn.innerHTML = '<i class="fas fa-envelope"></i> View My Email'; eBtn.addEventListener('click', function () { openEmailModal(); });
    upmActions.appendChild(hBtn); upmActions.appendChild(fBtn); upmActions.appendChild(eBtn);
    openModal(userProfileModal);
  }

  function setUpmLoading(btn, on) { btn.classList.toggle('loading', on); btn.disabled = on; }
  function syncUpmStateToSearch() { if (!upmCurrentUid || !upmCurrentRelation) return; syncSearchListRelation(upmCurrentUid, upmCurrentRelation); upmCurrentUid = null; upmCurrentRelation = null; }

  function openUserProfileModal(uid, username, relation) {
    upmCurrentUid = uid; upmCurrentRelation = relation;
    var upmUsername = document.getElementById('upmUsername');
    var upmUid = document.getElementById('upmUid');
    var upmRelation = document.getElementById('upmRelationBadge');
    var upmActions = document.getElementById('upmActions');
    upmUsername.textContent = username; upmUid.textContent = 'UID: ' + uid;
    var bc = 'none', bh = '';
    if (relation === 'friend') { bc = 'friend'; bh = '<i class="fas fa-user-check"></i> Friends'; }
    else if (relation === 'pending_sent') { bc = 'pending'; bh = '<i class="fas fa-clock"></i> Request Sent'; }
    else if (relation === 'pending_received') { bc = 'pending'; bh = '<i class="fas fa-bell"></i> Request Received'; }
    else { bc = 'none'; bh = '<i class="fas fa-user"></i> Not Friends'; }
    upmRelation.className = 'upm-relation-badge ' + bc; upmRelation.innerHTML = bh;
    upmActions.innerHTML = '';
    var h = document.createElement('button'); h.className = 'upm-btn upm-btn-history'; h.innerHTML = '<i class="fas fa-history"></i> Game History'; h.addEventListener('click', function () { showToast('Game history coming soon.', 'info'); }); upmActions.appendChild(h);
    var f = document.createElement('button'); f.className = 'upm-btn upm-btn-friends-list'; f.innerHTML = '<i class="fas fa-users"></i> Friends List'; f.addEventListener('click', function () { showToast('Friends list feature coming soon.', 'info'); }); upmActions.appendChild(f);
    if (relation === 'friend') {
      var rm = document.createElement('button'); rm.className = 'upm-btn upm-btn-remove'; rm.innerHTML = '<i class="fas fa-user-times"></i> Remove Friend';
      rm.addEventListener('click', function () { upmCurrentRelation = 'friend'; closeModal(userProfileModal); openRemoveOverlay(uid, username); }); upmActions.insertBefore(rm, upmActions.children[1]);
    } else if (relation === 'pending_sent') {
      var cn = document.createElement('button'); cn.className = 'upm-btn upm-btn-cancel'; cn.innerHTML = '<i class="fas fa-times-circle"></i> Cancel Request';
      cn.addEventListener('click', async function () {
        setUpmLoading(cn, true);
        try { await callSessionApi('cancel-friend-request', { uid: currentUser.uid, toUid: uid }); upmRelation.className = 'upm-relation-badge none'; upmRelation.innerHTML = '<i class="fas fa-user"></i> Not Friends'; upmCurrentRelation = 'none'; cn.remove(); var ab = document.createElement('button'); ab.className = 'upm-btn upm-btn-add'; ab.innerHTML = '<i class="fas fa-user-plus"></i> Add Friend'; ab.addEventListener('click', makeUpmAddHandler(ab, uid, username, upmRelation, upmActions)); upmActions.insertBefore(ab, upmActions.children[1]); syncSearchListRelation(uid, 'none'); showToast('Friend request cancelled.', 'info'); loadSentPanel(); }
        catch (err) { showToast(err.message, 'error'); setUpmLoading(cn, false); }
      }); upmActions.insertBefore(cn, upmActions.children[1]);
    } else if (relation === 'pending_received') {
      var ac = document.createElement('button'); ac.className = 'upm-btn upm-btn-add'; ac.innerHTML = '<i class="fas fa-check-circle"></i> Accept Request';
      ac.addEventListener('click', async function () {
        setUpmLoading(ac, true);
        try { await callSessionApi('accept-friend-request', { uid: currentUser.uid, fromUid: uid }); upmRelation.className = 'upm-relation-badge friend'; upmRelation.innerHTML = '<i class="fas fa-user-check"></i> Friends'; upmCurrentRelation = 'friend'; ac.remove(); showToast('Friend request accepted!', 'success'); loadFriendsPanel(); loadRequestsPanel(); }
        catch (err) { showToast(err.message, 'error'); setUpmLoading(ac, false); }
      }); upmActions.insertBefore(ac, upmActions.children[1]);
    } else {
      var ad = document.createElement('button'); ad.className = 'upm-btn upm-btn-add'; ad.innerHTML = '<i class="fas fa-user-plus"></i> Add Friend';
      ad.addEventListener('click', makeUpmAddHandler(ad, uid, username, upmRelation, upmActions)); upmActions.insertBefore(ad, upmActions.children[1]);
    }
    openModal(userProfileModal);
  }

  function makeUpmAddHandler(btn, uid, username, upmRelation, upmActions) {
    return async function () {
      setUpmLoading(btn, true);
      try {
        await callSessionApi('send-friend-request', { uid: currentUser.uid, toUid: uid });
        upmRelation.className = 'upm-relation-badge pending'; upmRelation.innerHTML = '<i class="fas fa-clock"></i> Request Sent'; upmCurrentRelation = 'pending_sent'; btn.remove();
        var cn = document.createElement('button'); cn.className = 'upm-btn upm-btn-cancel'; cn.innerHTML = '<i class="fas fa-times-circle"></i> Cancel Request';
        cn.addEventListener('click', async function () {
          setUpmLoading(cn, true);
          try { await callSessionApi('cancel-friend-request', { uid: currentUser.uid, toUid: uid }); upmRelation.className = 'upm-relation-badge none'; upmRelation.innerHTML = '<i class="fas fa-user"></i> Not Friends'; upmCurrentRelation = 'none'; cn.remove(); var ab = document.createElement('button'); ab.className = 'upm-btn upm-btn-add'; ab.innerHTML = '<i class="fas fa-user-plus"></i> Add Friend'; ab.addEventListener('click', makeUpmAddHandler(ab, uid, username, upmRelation, upmActions)); upmActions.insertBefore(ab, upmActions.children[1]); syncSearchListRelation(uid, 'none'); showToast('Friend request cancelled.', 'info'); loadSentPanel(); }
          catch (err) { showToast(err.message, 'error'); setUpmLoading(cn, false); }
        }); upmActions.insertBefore(cn, upmActions.children[1]); syncSearchListRelation(uid, 'pending_sent'); showToast('Friend request sent!', 'success');
      } catch (err) { showToast(err.message, 'error'); setUpmLoading(btn, false); }
    };
  }

  function syncSearchListRelation(uid, newRelation) {
    var items = searchResultsContainer ? searchResultsContainer.querySelectorAll('.player-item') : [];
    items.forEach(function(item) {
      var ad = item.querySelector('.player-item-right'); if (!ad) return;
      var match = false; ad.querySelectorAll('[data-uid]').forEach(function(b) { if (b.dataset.uid === uid) match = true; });
      if (!match) return;
      var username = item.querySelector('.username') ? item.querySelector('.username').textContent : uid;
      ad.innerHTML = '';
      var vb = document.createElement('button'); vb.className = 'btn-sm btn-icon'; vb.style.background = '#f5f3ff'; vb.style.color = '#6C00BF'; vb.title = 'View Profile'; vb.innerHTML = '<i class="fas fa-user"></i>';
      vb.addEventListener('click', function() { openUserProfileModal(uid, username, newRelation); });
      if (newRelation === 'pending_sent') {
        var cb = document.createElement('button'); cb.className = 'btn-sm btn-cancel-req'; cb.dataset.uid = uid; cb.innerHTML = '<i class="fas fa-times"></i> Cancel';
        cb.addEventListener('click', makeCancelHandler(cb, uid, ad, username)); ad.appendChild(vb); ad.appendChild(cb);
      } else if (newRelation === 'none') {
        var ab = document.createElement('button'); ab.className = 'btn-sm btn-add'; ab.dataset.uid = uid; ab.innerHTML = '<i class="fas fa-user-plus"></i> Add';
        ab.addEventListener('click', makeAddHandler(ab, uid, ad)); ad.appendChild(vb); ad.appendChild(ab);
      } else if (newRelation === 'friend') { ad.innerHTML = '<button class="btn-sm btn-already" disabled><i class="fas fa-user-check"></i> Friends</button>'; }
    });
  }

  function openRemoveOverlay(uid, name) { pendingRemoveUid = uid; pendingRemoveName = name; document.getElementById('rmFriendName').textContent = name; removeFriendOverlay.classList.add('active'); }
  function closeRemoveOverlay() { removeFriendOverlay.classList.remove('active'); pendingRemoveUid = null; pendingRemoveName = null; }
  document.getElementById('rmCancelBtn').addEventListener('click', closeRemoveOverlay);
  removeFriendOverlay.addEventListener('click', function (e) { if (e.target === removeFriendOverlay) closeRemoveOverlay(); });
  document.getElementById('rmConfirmBtn').addEventListener('click', async function () {
    if (!pendingRemoveUid) return;
    var btn = document.getElementById('rmConfirmBtn'); btn.disabled = true;
    try { await callSessionApi('remove-friend', { uid: currentUser.uid, friendUid: pendingRemoveUid }); closeRemoveOverlay(); closeCtxMenu(); showToast('Friend removed successfully.', 'info'); loadFriendsPanel(); }
    catch (err) { showToast(err.message, 'error'); } finally { btn.disabled = false; }
  });

  // ── Rename ──────────────────────────────────────────────────
  var renameBtn = document.getElementById('renameBtn');
  var renameModal = document.getElementById('renameModal');
  var newNameInput = document.getElementById('newNameInput');
  var passwordConfirmInput = document.getElementById('passwordConfirmInput');
  var confirmRenameBtn = document.getElementById('confirmRenameBtn');
  var usernameError = document.getElementById('UsernameError');
  var passwordErrorMessage = document.getElementById('passwordErrorMessage');
  var renameSuccessMessage = document.getElementById('renameSuccessMessage');
  var renameLoadingSpinner = document.getElementById('renameLoadingSpinner');

  renameBtn.addEventListener('click', function () { newNameInput.value = ''; passwordConfirmInput.value = ''; usernameError.style.display = 'none'; passwordErrorMessage.style.display = 'none'; renameSuccessMessage.style.display = 'none'; confirmRenameBtn.disabled = true; openModal(renameModal); });
  newNameInput.addEventListener('input', function () { var v = validateUsername(newNameInput.value.trim()); usernameError.style.display = 'none'; confirmRenameBtn.disabled = !(v.valid && passwordConfirmInput.value); });
  passwordConfirmInput.addEventListener('input', function () { confirmRenameBtn.disabled = !(validateUsername(newNameInput.value.trim()).valid && passwordConfirmInput.value); });
  confirmRenameBtn.addEventListener('click', async function () {
    var nu = newNameInput.value.trim(); var pw = passwordConfirmInput.value;
    if (!pw) { passwordErrorMessage.textContent = 'Please enter your password.'; passwordErrorMessage.style.display = 'block'; return; }
    renameLoadingSpinner.style.display = 'block'; confirmRenameBtn.disabled = true; usernameError.style.display = 'none'; passwordErrorMessage.style.display = 'none';
    try {
      var v = await callAuthApi('verify-password', { uid: currentUser.uid, password: pw });
      if (!v.valid) { passwordErrorMessage.textContent = 'Incorrect password.'; passwordErrorMessage.style.display = 'block'; return; }
      var c = await callSessionApi('check-username', { username: nu }); if (!c.available) { usernameError.style.display = 'block'; return; }
      var d = await callSessionApi('set-username', { uid: currentUser.uid, username: nu });
      if (d.success) { currentUser = d.user; localStorage.setItem('user', JSON.stringify(currentUser)); updateUsernameDisplay(); renameSuccessMessage.style.display = 'block'; setTimeout(function () { closeModal(renameModal); }, 1500); }
    } catch (err) { if (err.message.toLowerCase().includes('taken')) usernameError.style.display = 'block'; else { passwordErrorMessage.textContent = err.message; passwordErrorMessage.style.display = 'block'; } }
    finally { renameLoadingSpinner.style.display = 'none'; confirmRenameBtn.disabled = false; }
  });

  document.getElementById('signOutBtn').addEventListener('click', function () { openModal(document.getElementById('logoutConfirmModal')); });
  document.getElementById('confirmLogoutBtn').addEventListener('click', function () { localStorage.removeItem('user'); window.location.href = 'login&register.html'; });
  document.getElementById('cancelLogoutBtn').addEventListener('click', function () { closeModal(document.getElementById('logoutConfirmModal')); });

  // ── Players Modal ─────────────────────────────────────────
  var playersModal = document.getElementById('playersModal');
  document.getElementById('amisBtn').addEventListener('click', function () {
    _friendsFirstLoad = true; // reset pour animation au ré-ouverture
    openModal(playersModal); loadFriendsPanel(); loadRequestsBadge(); loadSentBadge(); updateFooterRequestsBadge(0);
  });
  document.querySelectorAll('.sidebar-item').forEach(function (item) {
    item.addEventListener('click', function () {
      document.querySelectorAll('.sidebar-item').forEach(function (s) { s.classList.remove('active'); }); item.classList.add('active');
      var pid = item.dataset.panel;
      document.querySelectorAll('.content-panel').forEach(function (p) { p.classList.remove('active-panel'); }); document.getElementById(pid).classList.add('active-panel');
      if (pid === 'friends-panel') { _friendsFirstLoad = true; loadFriendsPanel(); }
      if (pid === 'requests-panel') loadRequestsPanel();
      if (pid === 'sent-panel') loadSentPanel();
      if (pid === 'search-panel') document.getElementById('searchResultsContainer').innerHTML = '';
    });
  });

  function renderEmptyState(container, icon, msg) { container.innerHTML = '<div class="empty-state"><i class="fas fa-' + icon + '"></i><p>' + msg + '</p></div>'; }

  function openCtxMenu(triggerBtn, uid, name) {
    activeFriendUid = uid; activeFriendName = name; activeCtxTrigger = triggerBtn;
    var rect = triggerBtn.getBoundingClientRect(); var mw = 185;
    var left = rect.right - mw; if (left < 6) left = 6;
    var top = rect.bottom + 5; if (top + 180 > window.innerHeight) top = rect.top - 180;
    friendCtxMenu.style.left = left + 'px'; friendCtxMenu.style.top = top + 'px'; friendCtxMenu.style.minWidth = mw + 'px'; friendCtxMenu.classList.add('open');
    // Cacher "Invite to Play" si l'ami est offline
    var isOnline = triggerBtn.dataset.online === '1';
    var playBtn = document.getElementById('ctxPlayBtn');
    if (playBtn) playBtn.style.display = isOnline ? '' : 'none';
  }
  function closeCtxMenu() { friendCtxMenu.classList.remove('open'); activeCtxTrigger = null; }
  document.addEventListener('click', function (e) { if (!friendCtxMenu.classList.contains('open')) return; if (friendCtxMenu.contains(e.target)) return; if (activeCtxTrigger && activeCtxTrigger.contains(e.target)) return; closeCtxMenu(); });

  document.getElementById('ctxProfileBtn').addEventListener('click', function () { closeCtxMenu(); openUserProfileModal(activeFriendUid, activeFriendName, 'friend'); });
  document.getElementById('ctxChatBtn').addEventListener('click', function () { closeCtxMenu(); showToast('Chat feature coming soon.', 'info'); });
  document.getElementById('ctxPlayBtn').addEventListener('click', function () { closeCtxMenu(); showToast('Game invite feature coming soon.', 'info'); });
  document.getElementById('ctxRemoveBtn').addEventListener('click', function () { closeCtxMenu(); openRemoveOverlay(activeFriendUid, activeFriendName); });

  function formatLastSeen(ls) {
    if (!ls) return ''; var diff = Math.floor((Date.now() - ls) / 1000);
    if (diff < 60) return ''; var min = Math.floor(diff / 60); if (min < 60) return min + 'min ago';
    var hr = Math.floor(min / 60); if (hr < 24) return hr + 'h ago';
    var d = Math.floor(hr / 24); if (d < 365) return d + 'd ago'; return Math.floor(d / 365) + 'y ago';
  }

  var _friendsFirstLoad = true;

  async function loadFriendsPanel() {
    var container = document.getElementById('friendsListContainer');
    var isFirstLoad = _friendsFirstLoad || container.innerHTML === '';
    // Premier chargement seulement → spinner + scroll top
    if (isFirstLoad) {
      _friendsFirstLoad = false;
      container.innerHTML = '<div class="spinner-inline"></div>';
    }
    try {
      var data = await callSessionApi('get-friends', { uid: currentUser.uid });
      var cb = document.getElementById('friendsCountBadge'); var fc = data.friendCount || 0;
      cb.textContent = fc + '/100'; cb.style.display = fc > 0 ? 'inline-block' : 'none';
      if (!data.friends || data.friends.length === 0) {
        container.innerHTML = '';
        renderEmptyState(container, 'user-friends', 'You have no friends yet. Use "Add Friend" to get started.');
        return;
      }
      if (isFirstLoad) {
        // Construire la liste complète (premier chargement)
        container.innerHTML = '';
        data.friends.forEach(function (fr) {
          var div = document.createElement('div'); div.className = 'player-item'; div.dataset.uid = fr.uid;
          var lst = fr.online ? '' : formatLastSeen(fr.lastSeen);
          div.innerHTML = '<div class="player-item-left"><i class="fas fa-user-circle user-icon"></i><span class="username">' + escapeHtml(fr.username) + '</span>' + (lst ? '<span class="last-seen" data-ls>' + escapeHtml(lst) + '</span>' : '<span class="last-seen" data-ls></span>') + '<span class="status-dot ' + (fr.online ? 'online' : 'offline') + '" data-sd></span></div><div class="player-item-right"><button class="friend-ctx-btn" aria-label="Options" data-uid="' + fr.uid + '" data-name="' + escapeHtml(fr.username) + '" data-online="' + (fr.online ? '1' : '0') + '"><i class="fas fa-ellipsis-v"></i></button></div>';
          div.querySelector('.friend-ctx-btn').addEventListener('click', function (e) { e.stopPropagation(); var btn = e.currentTarget; if (friendCtxMenu.classList.contains('open') && activeFriendUid === btn.dataset.uid) closeCtxMenu(); else openCtxMenu(btn, btn.dataset.uid, btn.dataset.name); });
          container.appendChild(div);
        });
      } else {
        // Refresh: mettre à jour uniquement status dots + lastSeen, sans toucher au DOM principal
        var existingUids = new Set(Array.from(container.querySelectorAll('.player-item[data-uid]')).map(function(d){ return d.dataset.uid; }));
        var newUids = new Set(data.friends.map(function(f){ return f.uid; }));
        // Supprimer les items qui ne sont plus amis
        existingUids.forEach(function(uid) {
          if (!newUids.has(uid)) {
            var el = container.querySelector('.player-item[data-uid="' + uid + '"]');
            if (el) el.remove();
          }
        });
        // Mettre à jour ou ajouter
        data.friends.forEach(function (fr) {
          var existing = container.querySelector('.player-item[data-uid="' + fr.uid + '"]');
          if (existing) {
            // Update status dot
            var sd = existing.querySelector('[data-sd]');
            if (sd) { sd.className = 'status-dot ' + (fr.online ? 'online' : 'offline'); sd.setAttribute('data-sd',''); }
            // Mettre à jour data-online sur le ctx btn
            var ctxB = existing.querySelector('.friend-ctx-btn');
            if (ctxB) ctxB.dataset.online = fr.online ? '1' : '0';
            // Update lastSeen
            var ls = existing.querySelector('[data-ls]');
            var lst = fr.online ? '' : formatLastSeen(fr.lastSeen);
            if (ls) ls.textContent = lst;
          } else {
            // Nouvel ami → ajouter
            var div = document.createElement('div'); div.className = 'player-item'; div.dataset.uid = fr.uid;
            var lst2 = fr.online ? '' : formatLastSeen(fr.lastSeen);
            div.innerHTML = '<div class="player-item-left"><i class="fas fa-user-circle user-icon"></i><span class="username">' + escapeHtml(fr.username) + '</span>' + (lst2 ? '<span class="last-seen" data-ls>' + escapeHtml(lst2) + '</span>' : '<span class="last-seen" data-ls></span>') + '<span class="status-dot ' + (fr.online ? 'online' : 'offline') + '" data-sd></span></div><div class="player-item-right"><button class="friend-ctx-btn" aria-label="Options" data-uid="' + fr.uid + '" data-name="' + escapeHtml(fr.username) + '" data-online="' + (fr.online ? '1' : '0') + '"><i class="fas fa-ellipsis-v"></i></button></div>';
            div.querySelector('.friend-ctx-btn').addEventListener('click', function (e) { e.stopPropagation(); var btn = e.currentTarget; if (friendCtxMenu.classList.contains('open') && activeFriendUid === btn.dataset.uid) closeCtxMenu(); else openCtxMenu(btn, btn.dataset.uid, btn.dataset.name); });
            container.appendChild(div);
          }
        });
      }
    } catch (err) {
      if (isFirstLoad) { container.innerHTML = ''; renderEmptyState(container, 'exclamation-circle', 'Failed to load friends. Please try again.'); }
    }
  }

  async function loadRequestsBadge() {
    try { var data = await callSessionApi('get-friend-requests', { uid: currentUser.uid }); var count = (data.requests || []).length; var badge = document.getElementById('requestsBadge'); badge.textContent = count; badge.style.display = count > 0 ? 'inline-block' : 'none'; updateFooterRequestsBadge(count); } catch (e) {}
  }
  function updateFooterRequestsBadge(count) { var fb = document.getElementById('footerRequestsBadge'); if (!fb) return; if (count > 0) { fb.textContent = count > 9 ? '9+' : count; fb.style.display = 'flex'; } else { fb.style.display = 'none'; } }
  async function loadSentBadge() {
    try { var data = await callSessionApi('get-sent-requests', { uid: currentUser.uid }); var badge = document.getElementById('sentCountBadge'); var count = data.sentCount || (data.sent || []).length; badge.textContent = count; badge.style.display = count > 0 ? 'inline-block' : 'none'; } catch (e) {}
  }

  async function loadRequestsPanel() {
    var container = document.getElementById('requestsListContainer'); container.innerHTML = '<div class="spinner-inline"></div>';
    try {
      var data = await callSessionApi('get-friend-requests', { uid: currentUser.uid }); container.innerHTML = '';
      var badge = document.getElementById('requestsBadge');
      if (!data.requests || data.requests.length === 0) { badge.style.display = 'none'; renderEmptyState(container, 'handshake', 'No pending friend requests.'); return; }
      badge.textContent = data.requests.length; badge.style.display = 'inline-block';
      data.requests.forEach(function (req) {
        var div = document.createElement('div'); div.className = 'player-item';
        div.innerHTML = '<div class="player-item-left"><i class="fas fa-user-circle user-icon"></i><span class="username">' + escapeHtml(req.username) + '</span></div><div class="player-item-right"><button class="btn-sm btn-icon btn-accept-icon" title="Accept" data-uid="' + req.uid + '"><i class="fas fa-check"></i></button><button class="btn-sm btn-icon btn-reject-icon" title="Decline" data-uid="' + req.uid + '"><i class="fas fa-times"></i></button></div>';
        var aBtn = div.querySelector('.btn-accept-icon'); var rBtn = div.querySelector('.btn-reject-icon');
        aBtn.addEventListener('click', async function () { aBtn.classList.add('loading'); aBtn.disabled = true; rBtn.disabled = true; try { await callSessionApi('accept-friend-request', { uid: currentUser.uid, fromUid: aBtn.dataset.uid }); showToast('Friend request accepted!', 'success'); loadRequestsPanel(); loadFriendsPanel(); } catch (err) { showToast(err.message, 'error'); aBtn.classList.remove('loading'); aBtn.disabled = false; rBtn.disabled = false; } });
        rBtn.addEventListener('click', async function () { rBtn.classList.add('loading'); rBtn.disabled = true; aBtn.disabled = true; try { await callSessionApi('reject-friend-request', { uid: currentUser.uid, fromUid: rBtn.dataset.uid }); showToast('Friend request declined.', 'info'); loadRequestsPanel(); } catch (err) { showToast(err.message, 'error'); rBtn.classList.remove('loading'); rBtn.disabled = false; aBtn.disabled = false; } });
        container.appendChild(div);
      });
    } catch (err) { container.innerHTML = ''; renderEmptyState(container, 'exclamation-circle', 'Failed to load requests. Please try again.'); }
  }

  async function loadSentPanel() {
    var container = document.getElementById('sentListContainer'); container.innerHTML = '<div class="spinner-inline"></div>';
    try {
      var data = await callSessionApi('get-sent-requests', { uid: currentUser.uid }); container.innerHTML = '';
      var badge = document.getElementById('sentCountBadge'); var sc = data.sentCount || (data.sent || []).length;
      badge.textContent = sc; badge.style.display = sc > 0 ? 'inline-block' : 'none';
      if (!data.sent || data.sent.length === 0) { renderEmptyState(container, 'paper-plane', 'You have not sent any friend requests yet.'); return; }
      data.sent.forEach(function (req) {
        var div = document.createElement('div'); div.className = 'player-item';
        div.innerHTML = '<div class="player-item-left"><i class="fas fa-user-circle user-icon"></i><span class="username">' + escapeHtml(req.username) + '</span></div><div class="player-item-right"><button class="btn-sm btn-cancel" data-uid="' + req.uid + '"><i class="fas fa-times"></i> Cancel</button></div>';
        div.querySelector('.btn-cancel').addEventListener('click', async function (e) { var btn = e.currentTarget; btn.classList.add('loading'); btn.disabled = true; try { await callSessionApi('cancel-friend-request', { uid: currentUser.uid, toUid: btn.dataset.uid }); showToast('Friend request cancelled.', 'info'); loadSentPanel(); } catch (err) { showToast(err.message, 'error'); btn.classList.remove('loading'); btn.disabled = false; } });
        container.appendChild(div);
      });
    } catch (err) { container.innerHTML = ''; renderEmptyState(container, 'exclamation-circle', 'Failed to load sent requests. Please try again.'); }
  }

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
      if (!data.users || data.users.length === 0) { searchResultsContainer.innerHTML = '<p style="color:#64748b;font-size:0.88em;padding:4px 0;">No players found for "' + escapeHtml(query) + '".</p>'; return; }
      data.users.forEach(function (user) {
        var div = document.createElement('div'); div.className = 'player-item';
        var ad = document.createElement('div'); ad.className = 'player-item-right';
        if (user.relation === 'friend') { ad.innerHTML = '<button class="btn-sm btn-already" disabled><i class="fas fa-user-check"></i> Friends</button>'; }
        else if (user.relation === 'pending_sent') { var cb = document.createElement('button'); cb.className = 'btn-sm btn-cancel-req'; cb.dataset.uid = user.uid; cb.innerHTML = '<i class="fas fa-times"></i> Cancel'; cb.addEventListener('click', makeCancelHandler(cb, user.uid, ad)); ad.appendChild(cb); }
        else if (user.relation === 'pending_received') { var aB = document.createElement('button'); aB.className = 'btn-sm btn-icon btn-accept-icon'; aB.title = 'Accept'; aB.dataset.uid = user.uid; aB.innerHTML = '<i class="fas fa-check"></i>'; var rB = document.createElement('button'); rB.className = 'btn-sm btn-icon btn-reject-icon'; rB.title = 'Decline'; rB.dataset.uid = user.uid; rB.innerHTML = '<i class="fas fa-times"></i>'; aB.addEventListener('click', makeAcceptHandler(aB, rB, user.uid, ad)); rB.addEventListener('click', makeRejectHandler(aB, rB, user.uid, ad)); ad.appendChild(aB); ad.appendChild(rB); }
        else { var ab = document.createElement('button'); ab.className = 'btn-sm btn-add'; ab.dataset.uid = user.uid; ab.innerHTML = '<i class="fas fa-user-plus"></i> Add'; ab.addEventListener('click', makeAddHandler(ab, user.uid, ad)); ad.appendChild(ab); }
        var vb = document.createElement('button'); vb.className = 'btn-sm btn-icon'; vb.style.background = '#f5f3ff'; vb.style.color = '#6C00BF'; vb.title = 'View Profile'; vb.innerHTML = '<i class="fas fa-user"></i>';
        vb.addEventListener('click', (function(u, n, r) { return function() { openUserProfileModal(u, n, r); }; })(user.uid, user.username, user.relation));
        ad.insertBefore(vb, ad.firstChild);
        div.innerHTML = '<div class="player-item-left"><i class="fas fa-user-circle user-icon"></i><span class="username">' + escapeHtml(user.username) + '</span></div>';
        div.appendChild(ad); searchResultsContainer.appendChild(div);
      });
    } catch (err) { searchLoadingSpinner.style.display = 'none'; searchResultsContainer.innerHTML = '<p style="color:#ef4444;font-size:0.88em;">' + escapeHtml(err.message) + '</p>'; }
  });
  searchUserInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') searchUserBtn.click(); });

  function makeAddHandler(btn, uid, ad) {
    var su = ''; try { var pi = btn.closest('.player-item'); if (pi) su = pi.querySelector('.username').textContent; } catch(e){}
    return async function () {
      btn.classList.add('loading'); btn.disabled = true;
      try {
        await callSessionApi('send-friend-request', { uid: currentUser.uid, toUid: uid }); ad.innerHTML = '';
        var vb = document.createElement('button'); vb.className = 'btn-sm btn-icon'; vb.style.background = '#f5f3ff'; vb.style.color = '#6C00BF'; vb.title = 'View Profile'; vb.innerHTML = '<i class="fas fa-user"></i>'; vb.addEventListener('click', function() { openUserProfileModal(uid, su, 'pending_sent'); });
        var cb = document.createElement('button'); cb.className = 'btn-sm btn-cancel-req'; cb.dataset.uid = uid; cb.innerHTML = '<i class="fas fa-times"></i> Cancel'; cb.addEventListener('click', makeCancelHandler(cb, uid, ad, su));
        ad.appendChild(vb); ad.appendChild(cb); showToast('Friend request sent!', 'success');
      } catch (err) { showToast(err.message, 'error'); btn.classList.remove('loading'); btn.disabled = false; }
    };
  }
  function makeCancelHandler(btn, uid, ad, su) {
    return async function () {
      btn.classList.add('loading'); btn.disabled = true;
      var username = su || ''; if (!username) { try { var pi = btn.closest('.player-item'); if (pi) username = pi.querySelector('.username').textContent; } catch(e){} }
      try {
        await callSessionApi('cancel-friend-request', { uid: currentUser.uid, toUid: uid }); ad.innerHTML = '';
        var vb = document.createElement('button'); vb.className = 'btn-sm btn-icon'; vb.style.background = '#f5f3ff'; vb.style.color = '#6C00BF'; vb.title = 'View Profile'; vb.innerHTML = '<i class="fas fa-user"></i>'; vb.addEventListener('click', function() { openUserProfileModal(uid, username, 'none'); });
        var ab = document.createElement('button'); ab.className = 'btn-sm btn-add'; ab.dataset.uid = uid; ab.innerHTML = '<i class="fas fa-user-plus"></i> Add'; ab.addEventListener('click', makeAddHandler(ab, uid, ad));
        ad.appendChild(vb); ad.appendChild(ab); showToast('Friend request cancelled.', 'info'); loadSentPanel();
      } catch (err) { showToast(err.message, 'error'); btn.classList.remove('loading'); btn.disabled = false; }
    };
  }
  function makeAcceptHandler(aBtn, rBtn, uid, ad) {
    return async function () { aBtn.classList.add('loading'); aBtn.disabled = true; rBtn.disabled = true; try { await callSessionApi('accept-friend-request', { uid: currentUser.uid, fromUid: uid }); ad.innerHTML = '<button class="btn-sm btn-already" disabled><i class="fas fa-user-check"></i> Friends</button>'; showToast('Friend request accepted!', 'success'); loadFriendsPanel(); loadRequestsPanel(); } catch (err) { showToast(err.message, 'error'); aBtn.classList.remove('loading'); aBtn.disabled = false; rBtn.disabled = false; } };
  }
  function makeRejectHandler(aBtn, rBtn, uid, ad) {
    var su = ''; try { var pi = rBtn.closest('.player-item'); if (pi) su = pi.querySelector('.username').textContent; } catch(e){}
    return async function () {
      rBtn.classList.add('loading'); rBtn.disabled = true; aBtn.disabled = true;
      try {
        await callSessionApi('reject-friend-request', { uid: currentUser.uid, fromUid: uid }); ad.innerHTML = '';
        var vb = document.createElement('button'); vb.className = 'btn-sm btn-icon'; vb.style.background = '#f5f3ff'; vb.style.color = '#6C00BF'; vb.title = 'View Profile'; vb.innerHTML = '<i class="fas fa-user"></i>'; vb.addEventListener('click', function() { openUserProfileModal(uid, su, 'none'); });
        var ab = document.createElement('button'); ab.className = 'btn-sm btn-add'; ab.dataset.uid = uid; ab.innerHTML = '<i class="fas fa-user-plus"></i> Add'; ab.addEventListener('click', makeAddHandler(ab, uid, ad));
        ad.appendChild(vb); ad.appendChild(ab); showToast('Friend request declined.', 'info'); loadRequestsPanel();
      } catch (err) { showToast(err.message, 'error'); rBtn.classList.remove('loading'); rBtn.disabled = false; aBtn.disabled = false; }
    };
  }

  // ================================================================
  // GAME SELECT & GAME SETUP
  // ================================================================
  var gameSelectModal = document.getElementById('gameSelectModal');
  var gameSetupModal = document.getElementById('gameSetupModal');
  var inviteFriendsModal = document.getElementById('inviteFriendsModal');
  var selectedGame = null;
  var selectedColor = 'green';
  var selectedMinutes = 5;
  var gameOrigin = 'create';
  var gsDropdownOpen = false;
  // matchup data (rempli quand invitation acceptée)
  var matchupData = null; // { senderUsername, receiverUsername, isSender }

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
  document.getElementById('gameSelectCloseBtn').addEventListener('click', function () {
    if (gameOrigin === 'room' && matchupData) {
      // En room avec joueur connecté → confirmation avant quitter
      openRoomQuitConfirm();
    } else {
      closeModal(gameSelectModal);
    }
  });
  gameSelectModal.addEventListener('click', function (e) {
    if (e.target !== gameSelectModal) return;
    // En room avec matchup → ignorer le clic extérieur
    if (gameOrigin === 'room' && matchupData) return;
    closeModal(gameSelectModal);
  });

  document.querySelectorAll('.game-type-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      selectedGame = btn.dataset.game;
      closeModal(gameSelectModal);
      if (gameOrigin === 'room' && matchupData) {
        // Sync game immédiatement vers Firestore pour que le receiver voit le changement
        if (matchupData.inviteId) {
          callSessionApi('update-room-settings', { uid: currentUser.uid, inviteId: matchupData.inviteId, color: selectedColor, minutes: selectedMinutes, game: selectedGame }).catch(function(){});
        }
        openGameSetup(selectedGame, matchupData);
      } else {
        openGameSetup(selectedGame, null);
      }
    });
  });

  /**
   * openGameSetup
   * @param {string} game
   * @param {object|null} matchup — { senderUsername, receiverUsername } si invitation acceptée
   */
  // isSender = true → mpamorona room (sender), false → invité (receiver)
  var roomIsSender = true;
  // polling timer pour sync des settings depuis le sender vers le receiver
  var roomSyncTimer = null;
  // ready state du receiver (lu par sender via polling)
  var receiverReady = true; // par défaut true

  function openGameSetup(game, matchup) {
    matchupData = matchup || null;
    var label = gameLabels[game] || game;
    var headerImg = document.getElementById('gsHeaderImg');
    headerImg.innerHTML = '';
    var img = document.createElement('img'); img.src = gameImages[game] || ''; img.alt = label;
    img.onerror = function () { headerImg.innerHTML = '<span class="ph"><i class="fas fa-chess-board"></i></span>'; };
    headerImg.appendChild(img);
    document.getElementById('gsHeaderTitle').textContent = label;
    document.getElementById('gsHeaderSub').textContent = matchup ? 'Room · ' + selectedMinutes + ' min' : 'Configure your game settings';

    // Matchup strip
    var gsMatchup = document.getElementById('gsMatchup');
    if (matchup) {
      document.getElementById('gsMatchupSender').textContent = matchup.senderUsername;
      document.getElementById('gsMatchupReceiver').textContent = matchup.receiverUsername;
      gsMatchup.classList.add('visible');
    } else {
      gsMatchup.classList.remove('visible');
    }

    // Reset color/minutes SEULEMENT si pas en mode room
    // - si matchup présent (sender vient d'avoir un accepté) : garder selectedColor/selectedMinutes déjà set
    // - si gameOrigin=room sans matchup (sender retour après quitter receiver) : garder aussi
    // - sinon (create ou mode normal) : reset à green/5min
    var isRoomMode = (gameOrigin === 'room');
    if (!isRoomMode) {
      selectedColor = 'green'; selectedMinutes = 5;
    }
    document.querySelectorAll('.color-pick-btn').forEach(function (b) { b.classList.toggle('selected', b.dataset.color === selectedColor); });
    document.getElementById('gsTimeDisplay').textContent = selectedMinutes + ' min';
    document.querySelectorAll('.gs-time-option').forEach(function (o) {
      var sel = parseInt(o.dataset.minutes) === selectedMinutes; o.classList.toggle('selected', sel);
      var ck = o.querySelector('.gs-check'); if (ck) ck.style.display = sel ? '' : 'none';
    });
    closeGsDropdown();

    var launchBtn = document.getElementById('gsLaunchBtn');
    var gsBody = document.querySelector('.game-setup-body');
    var gsSectionLabelPiece = document.getElementById('gsSectionLabelPiece');

    // Stop any previous room sync polling
    if (roomSyncTimer) { clearInterval(roomSyncTimer); roomSyncTimer = null; }
    // Reset launch btn style
    launchBtn.style.background = '';

    if (gameOrigin === 'room' && !matchup) {
      // ── Sender avant matchup ──
      roomIsSender = true;
      gsBody.classList.remove('gs-receiver-mode');
      if (gsSectionLabelPiece) gsSectionLabelPiece.textContent = 'Choose Your Piece';
      launchBtn.innerHTML = '<i class="fas fa-user-plus"></i> Invite Friends';
      launchBtn.disabled = false;
    } else if (gameOrigin === 'room' && matchup) {
      roomIsSender = matchup.isSender !== false;
      receiverIsReady = true;

      if (roomIsSender) {
        // Sender avec matchup
        gsBody.classList.remove('gs-receiver-mode');
        if (gsSectionLabelPiece) gsSectionLabelPiece.textContent = 'Choose Your Piece';
        launchBtn.innerHTML = '<i class="fas fa-play"></i> Start Game';
        launchBtn.style.background = '';
        launchBtn.disabled = false;
        var notReadyEl = document.getElementById('gsOpponentNotReady');
        if (notReadyEl) notReadyEl.style.display = 'none';
        startRoomSyncPolling(matchup.inviteId, true);
      } else {
        // Receiver
        gsBody.classList.add('gs-receiver-mode');
        if (gsSectionLabelPiece) gsSectionLabelPiece.textContent = 'Your Piece';
        // Couleur receiver = inverse sender
        var myColor = selectedColor === 'green' ? 'red' : 'green';
        applyReceiverColor(myColor);
        // Bouton Ready par défaut
        updateReceiverReadyBtn(true);
        receiverIsReady = true;
        launchBtn.disabled = false;
        startRoomSyncPolling(matchup.inviteId, false);
      }
    } else {
      // Mode normal
      roomIsSender = true;
      gsBody.classList.remove('gs-receiver-mode');
      if (gsSectionLabelPiece) gsSectionLabelPiece.textContent = 'Choose Your Piece';
      launchBtn.innerHTML = '<i class="fas fa-play"></i> Start Game';
      launchBtn.disabled = false;
    }

    // Cacher le bouton back pour le receiver
    var backBtn = document.getElementById('gameSetupBackBtn');
    if (backBtn) backBtn.classList.toggle('hidden', gameOrigin === 'room' && !!matchup && !roomIsSender);
    // Afficher Quit seulement quand room+matchup
    var quitBtn = document.getElementById('gsQuitBtn');
    if (quitBtn) quitBtn.classList.toggle('visible', gameOrigin === 'room' && !!matchup);
    // Afficher chat + layout flex quand room+matchup
    var bodyRow = document.getElementById('gsBodyRow');
    if (bodyRow) bodyRow.classList.toggle('room-active', gameOrigin === 'room' && !!matchup);

    openModal(gameSetupModal);
  }

  function applyReceiverColor(color) {
    document.querySelectorAll('.color-pick-btn').forEach(function (b) {
      b.classList.toggle('selected', b.dataset.color === color);
    });
  }

  function updateReceiverReadyBtn(isReady) {
    var launchBtn = document.getElementById('gsLaunchBtn');
    if (isReady) {
      launchBtn.innerHTML = '<i class="fas fa-check-circle"></i> Ready';
      launchBtn.style.background = 'linear-gradient(to right, #059669, #10b981)';
    } else {
      launchBtn.innerHTML = '<i class="fas fa-times-circle"></i> Not Ready';
      launchBtn.style.background = 'linear-gradient(to right, #dc2626, #ef4444)';
    }
    launchBtn.disabled = false;
  }

  var receiverIsReady = true; // état local du receiver

  var _handledRoomEvents = new Set(); // évite double traitement d'un même inviteId+event

  function startRoomSyncPolling(inviteId, isSender) {
    if (!inviteId) return;
    if (roomSyncTimer) { clearInterval(roomSyncTimer); roomSyncTimer = null; }
    var pollInterval = isSender ? 800 : 400;
    roomSyncTimer = setInterval(async function() {
      if (!gameSetupModal.classList.contains('active')) {
        clearInterval(roomSyncTimer); roomSyncTimer = null; return;
      }
      try {
        var res = await callSessionApi('check-game-invite-status', { uid: currentUser.uid, inviteId: inviteId });
        if (res.status === 'accepted') {
          // ── Offline detection: si l'autre joueur est offline → fermer room après 15s ══
          var opponentOnline = isSender ? (res.receiverOnline !== false) : (res.senderOnline !== false);
          if (!opponentOnline) {
            if (!window._roomOfflineTimer) {
              window._roomOfflineTimer = setTimeout(function() {
                window._roomOfflineTimer = null;
                if (roomSyncTimer) { clearInterval(roomSyncTimer); roomSyncTimer = null; }
                var offlineName = isSender
                  ? (matchupData && matchupData.receiverUsername ? matchupData.receiverUsername : 'Opponent')
                  : (matchupData && matchupData.senderUsername ? matchupData.senderUsername : 'Host');
                if (isSender) {
                  // Sender: receiver offline → reset room, sender peut réinviter
                  var offEvtKey = inviteId + ':offline';
                  if (_handledRoomEvents.has(offEvtKey)) return;
                  _handledRoomEvents.add(offEvtKey);
                  matchupData = null;
                  openGameSetup(selectedGame, null);
                  showToast(offlineName + ' went offline.', 'info', '⚠ Offline');
                } else {
                  // Receiver: sender offline → fermer tout
                  closeModal(gameSetupModal);
                  closeModal(gameSelectModal);
                  matchupData = null;
                  showToast(offlineName + ' went offline. Room closed.', 'info', '⚠ Offline');
                }
              }, 15000);
            }
          } else {
            if (window._roomOfflineTimer) { clearTimeout(window._roomOfflineTimer); window._roomOfflineTimer = null; }
          }

          if (isSender) {
            // Sender: vérifier ready state du receiver
            var rReady = (res.receiverReady !== false);
            receiverReady = rReady;
            var launchBtn = document.getElementById('gsLaunchBtn');
            var notReadyEl = document.getElementById('gsOpponentNotReady');
            if (launchBtn) {
              launchBtn.innerHTML = '<i class="fas fa-play"></i> Start Game';
              launchBtn.disabled = !rReady;
              launchBtn.style.background = rReady ? '' : 'linear-gradient(to right, #94a3b8, #64748b)';
            }
            if (notReadyEl) notReadyEl.style.display = rReady ? 'none' : 'inline';
          } else {
            // Receiver: sync color, minutes ET game depuis le sender
            var changed = false;
            if (res.color && res.color !== selectedColor) {
              selectedColor = res.color;
              applyReceiverColor(selectedColor === 'green' ? 'red' : 'green');
              changed = true;
            }
            if (res.minutes && res.minutes !== selectedMinutes) {
              selectedMinutes = res.minutes;
              document.getElementById('gsTimeDisplay').textContent = selectedMinutes + ' min';
              document.querySelectorAll('.gs-time-option').forEach(function(o) {
                var sel = parseInt(o.dataset.minutes) === selectedMinutes;
                o.classList.toggle('selected', sel);
                var ck = o.querySelector('.gs-check'); if (ck) ck.style.display = sel ? '' : 'none';
              });
            }
            // FIX 3: sync game mode
            if (res.game && res.game !== selectedGame) {
              selectedGame = res.game;
              // Mettre à jour le header
              var label = gameLabels[selectedGame] || selectedGame;
              var gsHeaderTitle = document.getElementById('gsHeaderTitle');
              var gsHeaderImg = document.getElementById('gsHeaderImg');
              if (gsHeaderTitle) gsHeaderTitle.textContent = label;
              if (gsHeaderImg) {
                gsHeaderImg.innerHTML = '';
                var img = document.createElement('img');
                img.src = gameImages[selectedGame] || '';
                img.alt = label;
                img.onerror = function() { gsHeaderImg.innerHTML = '<span class="ph"><i class="fas fa-chess-board"></i></span>'; };
                gsHeaderImg.appendChild(img);
              }
            }
          }
        } else if (res.status === 'declined' && isSender) {
          // Receiver a quitté → sender reste dans la room
          var evtKey = inviteId + ':declined';
          if (_handledRoomEvents.has(evtKey)) return;
          _handledRoomEvents.add(evtKey);
          clearInterval(roomSyncTimer); roomSyncTimer = null;
          if (window._roomOfflineTimer) { clearTimeout(window._roomOfflineTimer); window._roomOfflineTimer = null; }
          var receiverName = (matchupData && matchupData.receiverUsername) ? matchupData.receiverUsername : 'Opponent';
          matchupData = null;
          openGameSetup(selectedGame, null);
          showToast(receiverName + ' has left the room.', 'info', '⚠ Player left');
        } else if (res.status === 'cancelled' || res.status === 'not_found') {
          clearInterval(roomSyncTimer); roomSyncTimer = null;
          if (window._roomOfflineTimer) { clearTimeout(window._roomOfflineTimer); window._roomOfflineTimer = null; }
          if (!isSender) {
            // Receiver: sender a annulé → fermer tout
            closeModal(gameSetupModal);
            closeModal(gameSelectModal);
            var senderName2 = (matchupData && matchupData.senderUsername) ? matchupData.senderUsername : 'The host';
            showToast(senderName2 + ' has left the room.', 'info', '⚠ Room closed');
          }
          matchupData = null;
        }
      } catch(e) {}
    }, pollInterval);
  }

  // ── Room Quit Confirm ──────────────────────────────────────
  var roomQuitOverlay = document.getElementById('roomQuitOverlay');

  function openRoomQuitConfirm() {
    var opponentName = '—';
    if (matchupData) {
      opponentName = roomIsSender ? matchupData.receiverUsername : matchupData.senderUsername;
    }
    document.getElementById('rqTitle').textContent = 'Leave the room?';
    document.getElementById('rqMessage').textContent =
      'Are you sure you want to leave the room with ' + opponentName + '? Your opponent will also be removed.';
    roomQuitOverlay.classList.add('active');
  }

  function closeRoomQuitConfirm() {
    roomQuitOverlay.classList.remove('active');
  }

  async function quitRoom() {
    closeRoomQuitConfirm();
    // Annuler l'invitation → l'autre joueur sera notifié via polling (cancelled)
    if (matchupData && matchupData.inviteId) {
      try {
        // Sender annule, receiver decline — les deux marquent cancelled
        if (roomIsSender) {
          await callSessionApi('cancel-game-invite', { uid: currentUser.uid, inviteId: matchupData.inviteId });
        } else {
          await callSessionApi('decline-game-invite', { uid: currentUser.uid, inviteId: matchupData.inviteId });
        }
      } catch(e) {}
    }
    // Stopper sync polling + offline timer
    if (roomSyncTimer) { clearInterval(roomSyncTimer); roomSyncTimer = null; }
    if (window._roomOfflineTimer) { clearTimeout(window._roomOfflineTimer); window._roomOfflineTimer = null; }
    // Fermer tout
    closeGsDropdown();
    closeModal(gameSetupModal);
    closeModal(gameSelectModal);
    // Reset matchupData → sender peut réinviter
    matchupData = null;
    // Sender retourne au dashboard principal
    // Receiver: juste fermer, le toast d'info vient du polling de l'autre côté
  }

  document.getElementById('rqCancelBtn').addEventListener('click', closeRoomQuitConfirm);
  document.getElementById('rqConfirmBtn').addEventListener('click', quitRoom);
  roomQuitOverlay.addEventListener('click', function(e) { if (e.target === roomQuitOverlay) closeRoomQuitConfirm(); });

  // Bouton Quit dans le game-setup-header
  document.getElementById('gsQuitBtn').addEventListener('click', function() {
    openRoomQuitConfirm();
  });

  document.getElementById('gameSetupBackBtn').addEventListener('click', function () {
    if (!roomIsSender) return; // receiver n'a pas de bouton retour
    closeGsDropdown();
    if (roomSyncTimer) { clearInterval(roomSyncTimer); roomSyncTimer = null; }
    closeModal(gameSetupModal);
    gameOrigin = 'room';
    // matchupData conservé si receiver déjà présent, pour que game-type-btn le réutilise
    // matchupData = null seulement si pas encore de matchup
    if (!matchupData) openGameSelectModal('room');
    else openGameSelectModal('room');
  });
  gameSetupModal.addEventListener('click', function (e) { if (e.target === gameSetupModal) closeGsDropdown(); });

  document.querySelectorAll('.color-pick-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      // Receiver ne peut pas modifier
      if (!roomIsSender && matchupData) return;
      selectedColor = btn.dataset.color;
      document.querySelectorAll('.color-pick-btn').forEach(function (b) { b.classList.toggle('selected', b.dataset.color === selectedColor); });
      if (matchupData) document.getElementById('gsHeaderSub').textContent = 'Room · ' + selectedMinutes + ' min';
      // Sender: sync color vers Firestore pour que le receiver voit le changement
      if (roomIsSender && matchupData && matchupData.inviteId) {
        callSessionApi('update-room-settings', { uid: currentUser.uid, inviteId: matchupData.inviteId, color: selectedColor, minutes: selectedMinutes, game: selectedGame }).catch(function(){});
      }
    });
  });

  var gsTimeTrigger = document.getElementById('gsTimeTrigger');
  var gsTimeDropdown = document.getElementById('gsTimeDropdown');
  var gsTimeDropdownOverlay = document.getElementById('gsTimeDropdownOverlay');

  function openGsDropdown() { gsDropdownOpen = true; gsTimeDropdownOverlay.classList.add('open'); gsTimeDropdown.classList.add('open'); gsTimeTrigger.classList.add('open'); }
  function closeGsDropdown() { gsDropdownOpen = false; gsTimeDropdown.classList.remove('open'); gsTimeDropdownOverlay.classList.remove('open'); if (gsTimeTrigger) gsTimeTrigger.classList.remove('open'); }

  gsTimeTrigger.addEventListener('click', function (e) { e.stopPropagation(); if (gsDropdownOpen) closeGsDropdown(); else openGsDropdown(); });
  gsTimeDropdownOverlay.addEventListener('click', function (e) { if (e.target === gsTimeDropdownOverlay) closeGsDropdown(); });
  document.querySelectorAll('.gs-time-option').forEach(function (opt) {
    opt.addEventListener('click', function (e) {
      e.stopPropagation(); selectedMinutes = parseInt(opt.dataset.minutes); document.getElementById('gsTimeDisplay').textContent = selectedMinutes + ' min';
      document.querySelectorAll('.gs-time-option').forEach(function (o) { var sel = parseInt(o.dataset.minutes) === selectedMinutes; o.classList.toggle('selected', sel); var ck = o.querySelector('.gs-check'); if (ck) ck.style.display = sel ? '' : 'none'; });
      closeGsDropdown();
      // Sender: sync minutes vers Firestore
      if (roomIsSender && matchupData && matchupData.inviteId) {
        callSessionApi('update-room-settings', { uid: currentUser.uid, inviteId: matchupData.inviteId, color: selectedColor, minutes: selectedMinutes, game: selectedGame }).catch(function(){});
      }
    });
  });
  document.addEventListener('click', function (e) { if (gsDropdownOpen && gsTimeDropdownOverlay && !gsTimeDropdownOverlay.contains(e.target)) closeGsDropdown(); });

  document.getElementById('gsLaunchBtn').addEventListener('click', function () {
    if (gameOrigin === 'room' && !matchupData) {
      // Sender sans matchup → ouvrir invite modal
      closeGsDropdown(); closeModal(gameSetupModal); openInviteFriendsModal();
    } else if (gameOrigin === 'room' && matchupData && !roomIsSender) {
      // Receiver → toggle ready/not ready
      receiverIsReady = !receiverIsReady;
      updateReceiverReadyBtn(receiverIsReady);
      // Sync ready state vers Firestore
      if (matchupData && matchupData.inviteId) {
        callSessionApi('update-room-ready', { uid: currentUser.uid, inviteId: matchupData.inviteId, ready: receiverIsReady }).catch(function(){});
      }
    } else {
      // Sender avec matchup → Start Game
      showToast('Game launch coming soon.', 'info');
    }
  });

  // ================================================================
  // INVITE FRIENDS MODAL
  // ================================================================
  var inviteTimers = {};       // uid → intervalId (countdown button)
  var inviteStatusTimers = {}; // inviteId → intervalId (poll status)
  var activeInviteIds = {};    // uid → inviteId

  function openInviteFriendsModal() {
    var label = gameLabels[selectedGame] || selectedGame || 'Game';
    var headerImg = document.getElementById('inviteHeaderImg'); headerImg.innerHTML = '';
    var img = document.createElement('img'); img.src = gameImages[selectedGame] || ''; img.alt = label;
    img.onerror = function () { headerImg.innerHTML = '<span class="ph"><i class="fas fa-chess-board"></i></span>'; };
    headerImg.appendChild(img);
    document.getElementById('inviteHeaderTitle').textContent = 'Invite Friends';
    document.getElementById('inviteHeaderSub').textContent = label + ' · ' + selectedMinutes + ' min';
    // Reset timers
    Object.keys(inviteTimers).forEach(function(uid) { clearInterval(inviteTimers[uid]); });
    Object.keys(inviteStatusTimers).forEach(function(id) { clearInterval(inviteStatusTimers[id]); });
    inviteTimers = {}; inviteStatusTimers = {}; activeInviteIds = {};
    _handledRoomEvents.clear();
    openModal(inviteFriendsModal);
    loadOnlineFriendsForInvite();
  }

  async function loadOnlineFriendsForInvite() {
    var container = document.getElementById('inviteFriendsList');
    container.innerHTML = '<div class="invite-spinner"></div>';
    try {
      var data = await callSessionApi('get-friends', { uid: currentUser.uid });
      container.innerHTML = '';
      var onlineFriends = (data.friends || []).filter(function(f) { return f.online; });
      if (onlineFriends.length === 0) {
        container.innerHTML = '<div class="invite-empty-state"><i class="fas fa-wifi"></i><p>No friends are online right now.<br>Invite them when they connect!</p></div>';
        return;
      }
      onlineFriends.forEach(function(friend) {
        var div = document.createElement('div'); div.className = 'invite-friend-item';
        var leftDiv = document.createElement('div'); leftDiv.className = 'invite-friend-left';
        leftDiv.innerHTML = '<i class="fas fa-user-circle user-icon"></i><span class="username">' + escapeHtml(friend.username) + '</span><span class="status-dot online"></span>';
        var inviteBtn = document.createElement('button'); inviteBtn.className = 'btn-invite'; inviteBtn.dataset.uid = friend.uid;
        inviteBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Invite';
        inviteBtn.addEventListener('click', (function(btn, f) {
          return function() {
            if (inviteTimers[f.uid]) return; // already counting
            startSendInvite(btn, f);
          };
        })(inviteBtn, friend));
        div.appendChild(leftDiv); div.appendChild(inviteBtn); container.appendChild(div);
      });
    } catch(err) {
      container.innerHTML = '<div class="invite-empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load friends. Please try again.</p></div>';
    }
  }

  async function startSendInvite(btn, friend) {
    btn.disabled = true; btn.classList.add('counting');
    // 1. Envoyer l'invitation via API
    var inviteId = null;
    try {
      var res = await callSessionApi('send-game-invite', {
        uid: currentUser.uid, toUid: friend.uid,
        game: selectedGame, color: selectedColor, minutes: selectedMinutes
      });
      inviteId = res.inviteId;
      activeInviteIds[friend.uid] = inviteId;
    } catch(err) {
      btn.disabled = false; btn.classList.remove('counting'); btn.innerHTML = '<i class="fas fa-paper-plane"></i> Invite';
      showToast(err.message || 'Failed to send invitation.', 'error');
      return;
    }

    // 2. Countdown 10s sur le bouton
    var count = 10;
    btn.textContent = count;
    var btnIvl = setInterval(function() {
      count--;
      if (count <= 0) {
        clearInterval(btnIvl); delete inviteTimers[friend.uid];
        btn.classList.remove('counting'); btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-paper-plane"></i> Invite';
        // Annuler l'invitation si toujours pending
        callSessionApi('cancel-game-invite', { uid: currentUser.uid, inviteId: inviteId }).catch(function(){});
        // Arrêter le polling de statut
        if (inviteStatusTimers[inviteId]) { clearInterval(inviteStatusTimers[inviteId]); delete inviteStatusTimers[inviteId]; }
        delete activeInviteIds[friend.uid];
      } else {
        btn.textContent = count;
      }
    }, 1000);
    inviteTimers[friend.uid] = btnIvl;

    // 3. Polling du statut: l'expéditeur surveille si l'invitation a été acceptée
    var statusIvl = setInterval(async function() {
      try {
        var statusRes = await callSessionApi('check-game-invite-status', { uid: currentUser.uid, inviteId: inviteId });
        if (statusRes.status === 'accepted') {
          // Invitation acceptée → arrêter tout
          clearInterval(statusIvl); delete inviteStatusTimers[inviteId];
          clearInterval(btnIvl); delete inviteTimers[friend.uid];
          delete activeInviteIds[friend.uid];
          // Fermer invite modal, ouvrir gameSetupModal avec matchup
          closeModal(inviteFriendsModal);
          selectedGame = statusRes.game;
          selectedMinutes = statusRes.minutes;
          selectedColor = statusRes.color;
          openGameSetup(statusRes.game, {
            senderUsername: statusRes.senderUsername,
            receiverUsername: statusRes.receiverUsername,
            isSender: true,       // je suis le sender
            inviteId: inviteId    // pour le sync polling
          });
        } else if (statusRes.status === 'declined' || statusRes.status === 'expired' || statusRes.status === 'cancelled' || statusRes.status === 'not_found') {
          clearInterval(statusIvl); delete inviteStatusTimers[inviteId];
          clearInterval(btnIvl); delete inviteTimers[friend.uid];
          delete activeInviteIds[friend.uid];
          btn.classList.remove('counting'); btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-paper-plane"></i> Invite';
          if (statusRes.status === 'declined') showToast(friend.username + ' declined your invitation.', 'info');
        }
      } catch(e) {}
    }, 500);
    inviteStatusTimers[inviteId] = statusIvl;
  }

  document.getElementById('inviteModalBackBtn').addEventListener('click', function () {
    // Annuler toutes les invitations en cours
    Object.keys(inviteTimers).forEach(function(uid) { clearInterval(inviteTimers[uid]); });
    Object.keys(inviteStatusTimers).forEach(function(id) { clearInterval(inviteStatusTimers[id]); });
    Object.keys(activeInviteIds).forEach(function(uid) {
      callSessionApi('cancel-game-invite', { uid: currentUser.uid, inviteId: activeInviteIds[uid] }).catch(function(){});
    });
    inviteTimers = {}; inviteStatusTimers = {}; activeInviteIds = {};
    closeModal(inviteFriendsModal);
    openGameSetup(selectedGame, null);
  });

  // ================================================================
  // GAME INVITE NOTIFICATION — destinataire uniquement
  // Polling toutes les 3s pour détecter une invitation entrante
  // ================================================================
  var ginNotif = document.getElementById('gameInviteNotif');
  var ginProgressBar = document.getElementById('ginProgressBar');
  var ginCountdownEl = document.getElementById('ginCountdown');
  var ginUsernameEl = document.getElementById('ginUsername');
  var ginAcceptBtn = document.getElementById('ginAcceptBtn');
  var ginDeclineBtn = document.getElementById('ginDeclineBtn');
  var ginTimer = null;
  var currentGinInviteId = null;
  var ginPollingTimer = null;
  var acceptedInviteIds = new Set(); // IDs déjà acceptés → ne plus afficher

  function startGameInvitePolling() {
    if (ginPollingTimer) return;
    ginPollingTimer = setInterval(async function() {
      if (!currentUser) return;
      try {
        var res = await callSessionApi('check-game-invite', { uid: currentUser.uid });
        if (res.invite) {
          var iid = res.invite.inviteId;
          // Ignorer: déjà affiché OU déjà accepté/refusé
          if (iid !== currentGinInviteId && !acceptedInviteIds.has(iid)) {
            currentGinInviteId = null;
            showGameInviteNotif(res.invite);
          }
        } else {
          // Pas d'invitation pending → si une notif est affichée pour une invite qui n'existe plus, cacher
          // (cas: l'expéditeur a annulé pendant que le destinataire n'a pas encore répondu)
          if (currentGinInviteId && ginNotif.classList.contains('gin-visible')) {
            hideGameInviteNotif();
          }
        }
      } catch(e) {}
    }, 800);
  }

  function showGameInviteNotif(invite) {
    if (ginTimer) { clearInterval(ginTimer); ginTimer = null; }
    currentGinInviteId = invite.inviteId;
    ginUsernameEl.textContent = invite.fromUsername;
    ginCountdownEl.textContent = '10';

    // Reset complet de l'état visuel
    ginNotif.classList.remove('gin-expanded', 'gin-visible');
    ginProgressBar.style.transition = 'none';
    ginProgressBar.style.transform = 'scaleX(1)';

    // Force reflow pour que le reset soit bien appliqué avant l'animation
    void ginNotif.offsetHeight;

    // Afficher la notification
    ginNotif.classList.add('gin-visible');

    // Après 300ms, élargir et lancer la progress bar
    setTimeout(function() {
      ginNotif.classList.add('gin-expanded');
      // Force reflow avant la transition de la progress bar
      void ginProgressBar.offsetHeight;
      ginProgressBar.style.transition = 'transform 10s linear';
      ginProgressBar.style.transform = 'scaleX(0)';
    }, 300);

    var count = 10;
    ginTimer = setInterval(function() {
      count--;
      ginCountdownEl.textContent = count > 0 ? count : '0';
      if (count <= 0) { clearInterval(ginTimer); ginTimer = null; hideGameInviteNotif(); }
    }, 1000);
  }

  function hideGameInviteNotif() {
    if (ginTimer) { clearInterval(ginTimer); ginTimer = null; }
    ginNotif.classList.remove('gin-visible', 'gin-expanded');
    ginProgressBar.style.transition = 'none';
    ginProgressBar.style.transform = 'scaleX(1)';
    currentGinInviteId = null;
  }

  ginAcceptBtn.addEventListener('click', async function() {
    if (!currentGinInviteId) return;
    var inviteId = currentGinInviteId;
    acceptedInviteIds.add(inviteId);
    hideGameInviteNotif();
    // Fermer tous les modals ouverts avant d'ouvrir la room
    document.querySelectorAll('.modal-overlay.active').forEach(function(m) {
      if (m.id !== 'gameSetupModal') closeModal(m);
    });
    // Fermer aussi les overlays spéciaux
    if (document.getElementById('removeFriendOverlay').classList.contains('active')) {
      document.getElementById('removeFriendOverlay').classList.remove('active');
    }
    try {
      var res = await callSessionApi('accept-game-invite', { uid: currentUser.uid, inviteId: inviteId });
      if (res.success) {
        selectedGame = res.game;
        selectedMinutes = res.minutes;
        selectedColor = res.color;
        gameOrigin = 'room';
        openGameSetup(res.game, {
          senderUsername: res.senderUsername,
          receiverUsername: res.receiverUsername,
          isSender: false,
          inviteId: inviteId
        });
      }
    } catch(err) {
      showToast(err.message || 'Failed to accept invitation.', 'error');
    }
  });

  ginDeclineBtn.addEventListener('click', async function() {
    if (!currentGinInviteId) return;
    var inviteId = currentGinInviteId;
    acceptedInviteIds.add(inviteId); // marquer → ne plus réafficher
    hideGameInviteNotif();
    try { await callSessionApi('decline-game-invite', { uid: currentUser.uid, inviteId: inviteId }); }
    catch(e) {}
  });

  // ── UID copy ─────────────────────────────────────────────────
  var upmCopyUidBtn = document.getElementById('upmCopyUidBtn');
  if (upmCopyUidBtn) {
    upmCopyUidBtn.addEventListener('click', function () {
      var uidText = document.getElementById('upmUid').textContent.replace('UID: ', '').trim();
      if (!uidText || uidText === '—') return;
      navigator.clipboard.writeText(uidText).then(function () { upmCopyUidBtn.innerHTML = '<i class="fas fa-check"></i>'; upmCopyUidBtn.classList.add('copied'); setTimeout(function () { upmCopyUidBtn.innerHTML = '<i class="fas fa-copy"></i>'; upmCopyUidBtn.classList.remove('copied'); }, 2000); }).catch(function () { showToast('Copy failed.', 'error'); });
    });
  }

  // ── Email modal ───────────────────────────────────────────────
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

  // ── Room chat input auto-resize ──────────────────────────
  var gsChatInput = document.getElementById('gsChatInput');
  if (gsChatInput) {
    gsChatInput.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 72) + 'px';
    });
    gsChatInput.addEventListener('keydown', function(e) {
      // Shift+Enter = nouvelle ligne, Enter seul = send (placeholder only)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // TODO: send message
      }
    });
  }

  window.showToast = showToast;
  loadSession();
})();
