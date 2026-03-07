import nodemailer from "nodemailer";

if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
  throw new Error("EMAIL_USER or EMAIL_PASS not set");
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

export async function sendOTPEmail(to, otp) {
  
  const mailOptions = {
    from: `"Tutoriel" <${process.env.EMAIL_USER}>`,
    to,
    subject: "Email Verification Code",
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Email Verification</h2>
        <p>Your verification code is:</p>
        <h1 style="letter-spacing:5px; font-size:32px;">
          ${otp}
        </h1>
        <p>This code expires in 5 minutes.</p>
        <hr/>
        <small>If you did not request this code, you can ignore this email.</small>
      </div>
    `
  };
  
  await transporter.sendMail(mailOptions);
}
