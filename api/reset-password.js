import admin from "firebase-admin";
import bcrypt from "bcryptjs";

export default async function handler(req, res) {

  const { identifier, newPassword } = req.body;

  if (!identifier || !newPassword || newPassword.length < 6)
    return res.status(400).json({ error: "Invalid data" });

  const db = admin.database();

  const snap = await db.ref("users")
    .orderByChild("email")
    .equalTo(identifier.toLowerCase().trim())
    .limitToFirst(1)
    .get();

  if (!snap.exists())
    return res.status(400).json({ error: "Invalid request" });

  const userData = Object.values(snap.val())[0];
  const userRef = db.ref("users/" + userData.uid);

  if (!userData.resetOtpVerified)
    return res.status(403).json({ error: "Verification required" });

  const hashed = await bcrypt.hash(newPassword, 12);

  await userRef.update({
    password: hashed,
    resetOTP: null,
    resetOTPExpires: null,
    resetOtpVerified: null,
    resetOtpAttempts: 0,
    resetOtpBlockUntil: null
  });

  return res.status(200).json({ success: true });
}
