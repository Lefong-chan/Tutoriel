import admin from "firebase-admin";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;

if (!process.env.FIREBASE_KEY) {
  throw new Error("FIREBASE_KEY not set");
}

if (!SECRET) {
  throw new Error("JWT_SECRET not set");
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

  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const { identifier, otp } = req.body;

  if (!identifier || !otp)
    return res.status(400).json({ error: "Email and OTP required" });

  try {

    const snap = await db
      .ref("users")
      .orderByChild("email")
      .equalTo(identifier.toLowerCase())
      .limitToFirst(1)
      .get();

    if (!snap.exists())
      return res.status(400).json({ error: "User not found" });

    const userData = Object.values(snap.val())[0];

    if (userData.emailVerified)
      return res.status(400).json({ error: "Email already verified" });

    if (!userData.otp || userData.otp !== otp)
      return res.status(400).json({ error: "Invalid code" });

    if (Date.now() > userData.otpExpires)
      return res.status(400).json({ error: "Code expired" });

    // SUCCESS
    await db.ref("users/" + userData.uid).update({
      emailVerified: true,
      otp: null,
      otpExpires: null
    });

    const token = jwt.sign(
      {
        uid: userData.uid,
        email: userData.email,
        provider: userData.provider
      },
      SECRET,
      { expiresIn: "7d" }
    );

    res.setHeader("Set-Cookie", `
      token=${token};
      HttpOnly;
      Secure;
      SameSite=Strict;
      Path=/;
      Max-Age=${7 * 24 * 60 * 60}
    `.replace(/\s+/g, " ").trim());

    return res.json({ success: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
