import admin from "firebase-admin";
import { sendOTPEmail } from "./mailer.js";
import { sendPhoneOTP } from "./sms.js";

const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!process.env.FIREBASE_KEY)
  throw new Error("FIREBASE_KEY not set");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  if (serviceAccount.private_key)
    serviceAccount.private_key =
      serviceAccount.private_key.replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL:
      "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneRegex = /^(\+261|0)[0-9]{9}$/;

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export default async function handler(req, res) {

  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  if (allowedOrigin &&
      req.headers.origin !== allowedOrigin)
    return res.status(403).json({ error: "Forbidden" });

  const { identifier } = req.body;

  if (!identifier)
    return res.status(400).json({ error: "Identifier required" });

  try {

    const value = identifier.trim();
    const now = Date.now();
    let snap;

    if (emailRegex.test(value)) {
      snap = await db.ref("users")
        .orderByChild("email")
        .equalTo(value.toLowerCase())
        .limitToFirst(1)
        .get();
    } else if (phoneRegex.test(value)) {
      snap = await db.ref("users")
        .orderByChild("phone")
        .equalTo(value)
        .limitToFirst(1)
        .get();
    } else {
      return res.status(400).json({ error: "Invalid format" });
    }

    // Anti-enumeration
    if (!snap.exists()) {
      return res.status(200).json({ success: true });
    }

    const userData = Object.values(snap.val())[0];
    const userRef = db.ref("users/" + userData.uid);

    const otp = generateOTP();
    const expiry = now + (5 * 60 * 1000);

    await userRef.update({
      resetOTP: otp,
      resetOTPExpires: expiry,
      resetOtpAttempts: 0,
      resetOtpBlockUntil: null
    });

    if (emailRegex.test(value))
      await sendOTPEmail(userData.email, otp);
    else
      await sendPhoneOTP(userData.phone, otp);

    return res.status(200).json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
}
