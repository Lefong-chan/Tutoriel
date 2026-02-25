import admin from "firebase-admin";

const allowedOrigin = process.env.ALLOWED_ORIGIN;

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

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (allowedOrigin && req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({
      error: "Email and OTP required"
    });
  }

  try {

    const emailLower = email.toLowerCase().trim();

    const snap = await db
      .ref("users")
      .orderByChild("email")
      .equalTo(emailLower)
      .limitToFirst(1)
      .get();

    if (!snap.exists()) {
      return res.status(400).json({
        error: "User not found"
      });
    }

    const userKey = Object.keys(snap.val())[0];
    const userData = snap.val()[userKey];

    if (userData.emailVerified) {
      return res.status(400).json({
        error: "Email already verified"
      });
    }

    if (!userData.otp || userData.otp !== otp) {
      return res.status(400).json({
        error: "Invalid OTP"
      });
    }

    if (Date.now() > userData.otpExpires) {
      return res.status(400).json({
        error: "OTP expired"
      });
    }

    await db.ref("users/" + userData.uid).update({
      emailVerified: true,
      otp: null,
      otpExpires: null
    });

    return res.status(200).json({
      success: true
    });

  } catch (err) {

    console.error("VERIFY OTP ERROR:", err);

    return res.status(500).json({
      error: "Server error"
    });
  }
}
