    (function () {
      var API_URL = '/api/auth';
      var container = document.getElementById('container');
      var loginForm = document.getElementById('loginForm');
      var inscriptionForm = document.getElementById('inscriptionForm');
      var statusModal = document.getElementById('statusModal');
      var modalTitle = document.getElementById('modalTitle');
      var modalMessage = document.getElementById('modalMessage');
      var otpModal = document.getElementById('otpModal');
      var otpCodeInput = document.getElementById('otpCode');
      var resendOtpBtn = document.getElementById('resendOtpBtn');
      var verifyOtpBtn = document.getElementById('verifyOtpBtn');
      var otpMessageDiv = document.getElementById('otpMessage');
      var forgotModal = document.getElementById('forgotModal');
      var forgotStep1 = document.getElementById('forgotStep1');
      var forgotStep2 = document.getElementById('forgotStep2');
      var forgotIdentifier = document.getElementById('forgotIdentifier');
      var forgotSendBtn = document.getElementById('forgotSendBtn');
      var forgotOtp = document.getElementById('forgotOtp');
      var forgotVerifyBtn = document.getElementById('forgotVerifyBtn');
      var forgotError1 = document.getElementById('forgotError1');
      var forgotNewPass = document.getElementById('forgotNewPass');
      var forgotConfirmPass = document.getElementById('forgotConfirmPass');
      var forgotResetBtn = document.getElementById('forgotResetBtn');
      var forgotError2 = document.getElementById('forgotError2');
      var loginBtn = document.getElementById('loginBtn');
      var registerBtn = document.getElementById('registerBtn');

      var currentEmail = '';
      var forgotEmail = '';
      var otpInterval = null;
      var forgotInterval = null;
      var statusTimeout = null;

      function showStatus(message, type, position) {
        if (statusTimeout) clearTimeout(statusTimeout);
        var icon = type === 'success' ? '<i class="fa-solid fa-circle-check"></i>' : '<i class="fa-solid fa-circle-exclamation"></i>';
        modalTitle.innerHTML = icon + ' ' + (type === 'success' ? 'Success' : 'Error');
        modalTitle.className = 'status-title ' + type;
        modalMessage.textContent = message;
        statusModal.className = 'status-alert show ' + type;
        statusModal.style.right = position === 'left' ? 'auto' : '20px';
        statusModal.style.left = position === 'left' ? '20px' : 'auto';
        statusTimeout = setTimeout(function () { statusModal.classList.remove('show'); }, 5000);
      }

      document.getElementById('closeStatusModal').addEventListener('click', function () {
        if (statusTimeout) clearTimeout(statusTimeout);
        statusModal.classList.remove('show');
      });

      async function callApi(action, payload) {
        var response = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ action: action }, payload))
        });
        var data = await response.json();
        if (!response.ok) {
          var err = new Error(data.error || 'An unexpected error occurred. Please try again.');
          if (data.emailNotVerified) err.emailNotVerified = true;
          throw err;
        }
        return data;
      }

      function setLoading(btn, on) {
        btn.classList.toggle('loading', on);
        btn.disabled = on;
      }

      function startCountdown(btn, seconds, getRef, setRef) {
        var cur = getRef();
        if (cur) clearInterval(cur);
        if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent;
        var end = Date.now() + seconds * 1000;
        function tick() {
          var rem = Math.max(0, Math.floor((end - Date.now()) / 1000));
          if (rem <= 0) {
            btn.disabled = false;
            btn.textContent = btn.dataset.originalText;
            clearInterval(getRef());
            setRef(null);
          } else {
            btn.disabled = true;
            var m = Math.floor(rem / 60), s = rem % 60;
            btn.textContent = m > 0 ? (m + ':' + String(s).padStart(2, '0')) : (s + 's');
          }
        }
        tick();
        setRef(setInterval(tick, 1000));
      }
      function startOtpCountdown(btn, sec) { startCountdown(btn, sec, function () { return otpInterval; }, function (v) { otpInterval = v; }); }
      function startForgotCountdown(btn, sec) { startCountdown(btn, sec, function () { return forgotInterval; }, function (v) { forgotInterval = v; }); }

      function setModalMessage(el, msg, type) {
        var icon = type === 'success' ? '<i class="fa-solid fa-circle-check"></i>' : '<i class="fa-solid fa-circle-exclamation"></i>';
        el.innerHTML = icon + ' <span>' + msg + '</span>';
        el.className = 'modal-info-text ' + type + ' visible';
      }
      function clearModalMessage(el) { el.innerHTML = ''; el.className = 'modal-info-text'; }

      function resetOtpModal() {
        otpCodeInput.value = '';
        clearModalMessage(otpMessageDiv);
        resendOtpBtn.disabled = false;
        resendOtpBtn.textContent = 'Resend';
        if (otpInterval) { clearInterval(otpInterval); otpInterval = null; }
      }
      function resetForgotModal() {
        forgotIdentifier.value = ''; forgotOtp.value = ''; forgotNewPass.value = ''; forgotConfirmPass.value = '';
        clearModalMessage(forgotError1); clearModalMessage(forgotError2);
        forgotSendBtn.disabled = false; forgotSendBtn.textContent = 'Send';
        delete forgotSendBtn.dataset.originalText;
        forgotStep1.classList.add('active'); forgotStep2.classList.remove('active');
        if (forgotInterval) { clearInterval(forgotInterval); forgotInterval = null; }
      }

      inscriptionForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var email = document.getElementById('regEmail').value.trim();
        var password = document.getElementById('regPass').value;
        if (!document.getElementById('termsCheck').checked) { showStatus('You must accept the Terms and Conditions to continue.', 'error', 'left'); return; }
        if (password.length < 6) { showStatus('Password must be at least 6 characters.', 'error', 'left'); return; }
        setLoading(registerBtn, true);
        try {
          var data = await callApi('register', { email: email, password: password });
          if (data.success && data.emailVerificationRequired) {
            currentEmail = email;
            resetOtpModal();
            setModalMessage(otpMessageDiv, 'Account created! A verification code has been sent to your email.', 'success');
            otpModal.classList.add('active');
            resendOtpBtn.dataset.originalText = 'Resend';
            startOtpCountdown(resendOtpBtn, 300);
          } else {
            showStatus('Registration failed. Please try again.', 'error', 'left');
          }
        } catch (err) {
          showStatus(err.message, 'error', 'left');
        } finally {
          setLoading(registerBtn, false);
        }
      });

      loginForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var identifier = document.getElementById('loginEmail').value.trim();
        var password = document.getElementById('loginPass').value;
        if (!identifier || !password) { showStatus('Please fill in all fields.', 'error', 'right'); return; }
        setLoading(loginBtn, true);
        try {
          var data = await callApi('login', { identifier: identifier, password: password });
          if (data.success) {
            showStatus('Login successful! Redirecting\u2026', 'success', 'right');
            localStorage.setItem('user', JSON.stringify({ uid: data.user.uid, email: data.user.email, username: data.user.username || '' }));
            setTimeout(function () { window.location.href = 'dashboard.html'; }, 1500);
          } else {
            showStatus('Login failed. Please try again.', 'error', 'right');
          }
        } catch (err) {
          if (err.emailNotVerified) {
            currentEmail = identifier;
            resetOtpModal();
            setModalMessage(otpMessageDiv, 'Your email is not verified. Please enter the code sent to your inbox.', 'error');
            otpModal.classList.add('active');
            startOtpCountdown(resendOtpBtn, 300);
          } else {
            showStatus(err.message, 'error', 'right');
          }
        } finally {
          setLoading(loginBtn, false);
        }
      });

      document.getElementById('closeOtpModal').addEventListener('click', function () { otpModal.classList.remove('active'); resetOtpModal(); });
      otpModal.addEventListener('click', function (e) { if (e.target === otpModal) { otpModal.classList.remove('active'); resetOtpModal(); } });

      verifyOtpBtn.addEventListener('click', async function () {
        var otp = otpCodeInput.value.trim();
        if (!otp || otp.length !== 6) { setModalMessage(otpMessageDiv, 'Please enter a valid 6-digit code.', 'error'); return; }
        setLoading(verifyOtpBtn, true);
        try {
          var data = await callApi('verify-otp', { identifier: currentEmail, otp: otp });
          if (data.success) {
            setModalMessage(otpMessageDiv, 'Email verified successfully! Redirecting\u2026', 'success');
            var ud = data.user ? { uid: data.user.uid, email: data.user.email, username: data.user.username || '' } : { email: currentEmail };
            localStorage.setItem('user', JSON.stringify(ud));
            setTimeout(function () { otpModal.classList.remove('active'); resetOtpModal(); window.location.href = 'dashboard.html'; }, 1500);
          } else {
            setModalMessage(otpMessageDiv, 'Verification failed. Please try again.', 'error');
          }
        } catch (err) {
          setModalMessage(otpMessageDiv, err.message, 'error');
        } finally {
          setLoading(verifyOtpBtn, false);
        }
      });

      resendOtpBtn.addEventListener('click', async function () {
        if (resendOtpBtn.disabled) return;
        setLoading(resendOtpBtn, true);
        try {
          var data = await callApi('resend-otp', { identifier: currentEmail });
          if (data.success) { setModalMessage(otpMessageDiv, 'A new code has been sent to your email.', 'success'); startOtpCountdown(resendOtpBtn, 300); }
          else { setModalMessage(otpMessageDiv, 'Failed to resend code. Please try again.', 'error'); }
        } catch (err) { setModalMessage(otpMessageDiv, err.message, 'error'); }
        finally { setLoading(resendOtpBtn, false); }
      });

      document.getElementById('forgotPasswordLink').addEventListener('click', function (e) { e.preventDefault(); resetForgotModal(); forgotModal.classList.add('active'); });
      document.getElementById('closeForgotModal').addEventListener('click', function () { forgotModal.classList.remove('active'); resetForgotModal(); });
      forgotModal.addEventListener('click', function (e) { if (e.target === forgotModal) { forgotModal.classList.remove('active'); resetForgotModal(); } });

      forgotSendBtn.addEventListener('click', async function () {
        var identifier = forgotIdentifier.value.trim();
        if (!identifier) { setModalMessage(forgotError1, 'Please enter your email address.', 'error'); return; }
        setLoading(forgotSendBtn, true);
        try {
          var data = await callApi('forgot-password-request', { identifier: identifier });
          if (data.success) {
            forgotEmail = identifier;
            setModalMessage(forgotError1, 'Code sent! Check your email inbox.', 'success');
            forgotSendBtn.dataset.originalText = 'Resend';
            startForgotCountdown(forgotSendBtn, 300);
          } else { setModalMessage(forgotError1, 'Failed to send code. Please try again.', 'error'); }
        } catch (err) { setModalMessage(forgotError1, err.message, 'error'); }
        finally { setLoading(forgotSendBtn, false); }
      });

      forgotVerifyBtn.addEventListener('click', async function () {
        var otp = forgotOtp.value.trim();
        if (!otp || otp.length !== 6) { setModalMessage(forgotError1, 'Please enter a valid 6-digit code.', 'error'); return; }
        if (!forgotEmail) { setModalMessage(forgotError1, 'Please request a code first.', 'error'); return; }
        setLoading(forgotVerifyBtn, true);
        try {
          var data = await callApi('forgot-password-verify', { identifier: forgotEmail, otp: otp });
          if (data.success) { clearModalMessage(forgotError1); forgotStep1.classList.remove('active'); forgotStep2.classList.add('active'); }
          else { setModalMessage(forgotError1, 'Invalid or expired code. Please try again.', 'error'); }
        } catch (err) { setModalMessage(forgotError1, err.message, 'error'); }
        finally { setLoading(forgotVerifyBtn, false); }
      });

      forgotResetBtn.addEventListener('click', async function () {
        var newPass = forgotNewPass.value;
        var confirmPass = forgotConfirmPass.value;
        var otp = forgotOtp.value.trim();
        if (!newPass || newPass.length < 6) { setModalMessage(forgotError2, 'Password must be at least 6 characters.', 'error'); return; }
        if (newPass !== confirmPass) { setModalMessage(forgotError2, 'Passwords do not match.', 'error'); return; }
        setLoading(forgotResetBtn, true);
        try {
          var data = await callApi('forgot-password-reset', { identifier: forgotEmail, otp: otp, newPassword: newPass });
          if (data.success) {
            setModalMessage(forgotError2, 'Password reset successfully! You can now sign in.', 'success');
            setTimeout(function () { forgotModal.classList.remove('active'); resetForgotModal(); }, 2000);
          } else { setModalMessage(forgotError2, 'Reset failed. Please try again.', 'error'); }
        } catch (err) { setModalMessage(forgotError2, err.message, 'error'); }
        finally { setLoading(forgotResetBtn, false); }
      });

      document.getElementById('inscriptionToggleBtn').addEventListener('click', function () { container.classList.add('active'); });
      document.getElementById('loginToggleBtn').addEventListener('click', function () { container.classList.remove('active'); });
      document.getElementById('toRegMobile').addEventListener('click', function (e) { e.preventDefault(); container.classList.add('active'); });
      document.getElementById('mobileLoginBtn').addEventListener('click', function (e) { e.preventDefault(); container.classList.remove('active'); });

      document.querySelectorAll('.toggle-password').forEach(function (icon) {
        icon.addEventListener('click', function () {
          var input = this.closest('.password-wrapper').querySelector('input');
          if (input) { input.type = input.type === 'password' ? 'text' : 'password'; this.classList.toggle('fa-eye-slash'); this.classList.toggle('fa-eye'); input.focus(); }
        });
      });

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          if (otpModal.classList.contains('active')) { otpModal.classList.remove('active'); resetOtpModal(); }
          if (forgotModal.classList.contains('active')) { forgotModal.classList.remove('active'); resetForgotModal(); }
        }
      });
    })();
