import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
    databaseURL: "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

function generateUID() {
  return Math.floor(100000000 + Math.random() * 900000000).toString();
}

export default async function handler(req, res) {
  
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  
  const { idToken } = req.body;
  
  if (!idToken) {
    return res.status(400).json({ error: "Missing Google token" });
  }
  
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const email = decoded.email;

    if (!email) {
      return res.status(400).json({ error: "No email found in Google account" });
    }

    const snap = await db.ref("users").get();
    const users = snap.val();
    
    if (users) {
      for (let key in users) {
        if (users[key].email === email) {
          return res.json({
            success: true,
            message: "User already exists"
          });
        }
      }
    }
    
    let uid;
    let exists = true;
    
    while (exists) {
      uid = generateUID();
      const check = await db.ref("users/" + uid).get();
      if (!check.exists()) exists = false;
    }
    
    await db.ref("users/" + uid).set({
      uid,
      email,
      provider: "google",
      createdAt: Date.now()
    });
    
    return res.json({
      success: true,
      message: "Google account created"
    });
    
  } catch (error) {
    return res.status(401).json({ error: "Invalid Google token" });
  }
            }
