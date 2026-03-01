import nodemailer from "nodemailer";

if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
  throw new Error("EMAIL_USER or EMAIL_PASS not set");
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

export async function sendVerificationEmail(to, code) {
  await transporter.sendMail({
    from: `"Malagasy Game" <${process.env.EMAIL_USER}>`,
    to,
    subject: "Your Verification Code",
    html: `
      <h2>Email Verification</h2>
      <p>Your verification code is:</p>
      <h1 style="letter-spacing:5px;">${code}</h1>
      <p>This code expires in 10 minutes.</p>
    `,
  });
}
