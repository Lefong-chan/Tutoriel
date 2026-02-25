import nodemailer from "nodemailer";

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
      <div style="font-family: Arial; padding: 20px;">
        <h2>Email Verification</h2>
        <p>Your verification code is:</p>
        <h1 style="letter-spacing:5px;">${otp}</h1>
        <p>This code expires in 10 minutes.</p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
}
