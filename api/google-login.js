import admin from "firebase-admin";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_KEY)
    ),
    databaseURL: "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {

    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: "Missing token" });
    }

    const decoded = await admin.auth().verifyIdToken(idToken);

    const firebaseUid = decoded.uid;
    const email = decoded.email;
    const name = decoded.name || "Google User";

    if (!email) {
      return res.status(400).json({ error: "No email found" });
    }

    const usersSnap = await db.ref("users").get();
    const users = usersSnap.val();

    let uidToUse = null;

    if (users) {
      for (let key in users) {
        if (users[key].email === email) {
          uidToUse = key;
          break;
        }
      }
    }

    if (!uidToUse) {

      uidToUse = firebaseUid;

      await db.ref("users/" + uidToUse).set({
        uid: uidToUse,
        username: name,
        email: email,
        provider: "google",
        createdAt: Date.now()
      });

    }

    const token = jwt.sign(
      { uid: uidToUse },
      SECRET,
      { expiresIn: "2h" }
    );

    return res.json({ token });

  } catch (error) {

    console.error(error);

    return res.status(401).json({
      error: "Invalid Google token"
    });
  }
}
