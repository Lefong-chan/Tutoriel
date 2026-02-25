import admin from "firebase-admin";
import bcrypt from "bcryptjs";

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

async function generateUID() {
  let uid;
  let snapshot;

  do {
    uid = Math.floor(100000000 + Math.random() * 900000000).toString();
    snapshot = await db.ref("users/" + uid).get();
  } while (snapshot.exists());

  return uid;
}

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (allowedOrigin && req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { email, phone, password } = req.body;

  if ((!email && !phone) || !password || password.length < 6) {
    return res.status(400).json({
      error: "Email or phone and valid password required"
    });
  }

  try {

    let emailLower = null;
    let phoneClean = null;

    if (email) {
      emailLower = email.toLowerCase().trim();

      const existingEmail = await db
        .ref("users")
        .orderByChild("email")
        .equalTo(emailLower)
        .limitToFirst(1)
        .get();

      if (existingEmail.exists()) {
        return res.status(400).json({
          error: "Email already registered"
        });
      }
    }

    if (phone) {
      phoneClean = phone.trim();

      const existingPhone = await db
        .ref("users")
        .orderByChild("phone")
        .equalTo(phoneClean)
        .limitToFirst(1)
        .get();

      if (existingPhone.exists()) {
        return res.status(400).json({
          error: "Phone already registered"
        });
      }
    }

    const hashed = await bcrypt.hash(password, 12);
    const uid = await generateUID();

    await db.ref("users/" + uid).set({
      uid,
      email: emailLower,
      phone: phoneClean,
      password: hashed,
      provider: "local",
      createdAt: Date.now()
    });

    return res.status(201).json({ success: true });

  } catch (err) {
    console.error("REGISTER ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
    }
