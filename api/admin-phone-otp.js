// admin-phone-otp.js

import admin from "firebase-admin";

if (!process.env.FIREBASE_KEY) {
  throw new Error("FIREBASE_KEY not set");
}

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

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {

    const snap = await db.ref("users").get();

    if (!snap.exists()) {
      return res.json([]);
    }

    const users = snap.val();

    const result = Object.values(users)
      .filter(u => u.phone && u.phoneOTP && !u.phoneVerified)
      .map(u => ({
        uid: u.uid,
        phone: u.phone,
        phoneOTP: u.phoneOTP,
        phoneOTPExpires: u.phoneOTPExpires
      }));

    return res.json(result);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
