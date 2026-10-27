import { z } from "zod";

// UI form rules only. H2's provider and server remain authoritative.
const email = z.string().trim().pipe(z.email("Enter a valid email address."));
const password = z
  .string()
  .min(8, "Use at least 8 characters.")
  .max(128, "Use no more than 128 characters.");
export const signInSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password."),
});
export const signUpSchema = z
  .object({ email, password, confirm: z.string() })
  .refine((data) => data.password === data.confirm, {
    message: "Passwords don't match.",
    path: ["confirm"],
  });
export const resetRequestSchema = z.object({ email });
export const newPasswordSchema = z
  .object({ password, confirm: z.string() })
  .refine((data) => data.password === data.confirm, {
    message: "Passwords don't match.",
    path: ["confirm"],
  });
