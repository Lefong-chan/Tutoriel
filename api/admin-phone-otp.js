import admin from "firebase-admin";

const PANEL_PASSWORD = process.env.ADMIN_PANEL_PASSWORD;

if (!process.env.FIREBASE_KEY)
  throw new Error("FIREBASE_KEY not set");

if (!PANEL_PASSWORD)
  throw new Error("ADMIN_PANEL_PASSWORD not set");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

  if (serviceAccount.private_key) {
    serviceAccount.private_key =
      serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL:
      "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

export default async function handler(req, res) {

  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const { password, type } = req.body;

  if (!password || password !== PANEL_PASSWORD)
    return res.status(401).json({ error: "Unauthorized" });

  try {

    const snap = await db.ref("users").get();

    if (!snap.exists())
      return res.json([]);

    const users = snap.val();
    const result = [];

    Object.values(users).forEach(u => {

      // PHONE TAB
      if (type === "phone" && u.phone && u.phoneOTP && !u.phoneVerified) {
        result.push({
          uid: u.uid,
          identifier: u.phone,
          otp: u.phoneOTP,
          expires: u.phoneOTPExpires
        });
      }

      // EMAIL TAB
      if (type === "email" && u.email && u.otp && !u.emailVerified) {
        result.push({
          uid: u.uid,
          identifier: u.email,
          otp: u.otp,
          expires: u.otpExpires
        });
      }

    });

    return res.json(result);

  } catch (err) {
    console.error("Admin OTP error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
