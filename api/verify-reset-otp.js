import admin from "firebase-admin";

const MAX_ATTEMPTS = 5;
const LOCK_TIME = 60 * 60 * 1000;

export default async function handler(req, res) {

  const { identifier, otp } = req.body;
  if (!identifier || !otp)
    return res.status(400).json({ error: "Invalid code" });

  const db = admin.database();
  const now = Date.now();

  const snap = await db.ref("users")
    .orderByChild("email")
    .equalTo(identifier.toLowerCase().trim())
    .limitToFirst(1)
    .get();

  if (!snap.exists())
    return res.status(400).json({ error: "Invalid code" });

  const userData = Object.values(snap.val())[0];
  const userRef = db.ref("users/" + userData.uid);

  if (userData.resetOtpBlockUntil &&
      now < userData.resetOtpBlockUntil)
    return res.status(429).json({ error: "Locked" });

  if (!userData.resetOTPExpires ||
      now > userData.resetOTPExpires)
    return res.status(400).json({ error: "Expired" });

  if (userData.resetOTP !== otp.trim()) {

    let attempts = (userData.resetOtpAttempts || 0) + 1;
    let update = { resetOtpAttempts: attempts };

    if (attempts >= MAX_ATTEMPTS)
      update.resetOtpBlockUntil = now + LOCK_TIME;

    await userRef.update(update);
    return res.status(400).json({ error: "Invalid code" });
  }

  await userRef.update({
    resetOtpVerified: true
  });

  return res.status(200).json({ success: true });
}
