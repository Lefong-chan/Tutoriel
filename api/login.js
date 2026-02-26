// login.js

import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;
const allowedOrigin = process.env.ALLOWED_ORIGIN;

/* =====================================================
   ENV CHECK
===================================================== */

if (!SECRET) {
  throw new Error("JWT_SECRET not set");
}

if (!process.env.FIREBASE_KEY) {
  throw new Error("FIREBASE_KEY not set");
}

/* =====================================================
   FIREBASE INIT
===================================================== */

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

/* =====================================================
   HANDLER
===================================================== */

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  if (allowedOrigin && req.headers.origin !== allowedOrigin) {
    return res.status(403).json({
      error: "Forbidden"
    });
  }

  const { identifier, password } = req.body;

  if (!identifier || !password) {
    return res.status(400).json({
      error: "Invalid credentials"
    });
  }

  try {

    const value = identifier.trim();
    let snap;

    /* =====================================================
       FIND USER (EMAIL OR PHONE)
    ===================================================== */

    if (value.includes("@")) {

      const emailLower = value.toLowerCase();

      snap = await db
        .ref("users")
        .orderByChild("email")
        .equalTo(emailLower)
        .limitToFirst(1)
        .get();

    } else {

      snap = await db
        .ref("users")
        .orderByChild("phone")
        .equalTo(value)
        .limitToFirst(1)
        .get();
    }

    if (!snap.exists()) {
      return res.status(400).json({
        error: "Invalid credentials"
      });
    }

    const userData = Object.values(snap.val())[0];

    /* =====================================================
       PROVIDER CHECK
    ===================================================== */

    if (userData.provider !== "local") {
      return res.status(400).json({
        error: "Use correct login method"
      });
    }

    /* =====================================================
       PASSWORD CHECK
    ===================================================== */

    const isMatch = await bcrypt.compare(
      password,
      userData.password
    );

    if (!isMatch) {
      return res.status(400).json({
        error: "Invalid credentials"
      });
    }

    /* =====================================================
       EMAIL VERIFICATION CHECK
    ===================================================== */

    if (userData.email && !userData.emailVerified) {
      return res.status(403).json({
        error: "Email not verified",
        emailNotVerified: true
      });
    }

    /* =====================================================
       GENERATE JWT
    ===================================================== */

    const token = jwt.sign(
      {
        uid: userData.uid,
        email: userData.email || null,
        phone: userData.phone || null,
        provider: userData.provider
      },
      SECRET,
      { expiresIn: "7d" } // match verify-otp
    );

    return res.status(200).json({
      success: true,
      token,
      user: {
        uid: userData.uid,
        email: userData.email || null,
        phone: userData.phone || null,
        provider: userData.provider
      }
    });

  } catch (err) {

    console.error("LOGIN ERROR:", err);

    return res.status(500).json({
      error: "Server error"
    });
  }
}
