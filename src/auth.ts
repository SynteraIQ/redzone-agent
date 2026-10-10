import GoogleProvider from "next-auth/providers/google";
import type { NextAuthOptions } from "next-auth";

const googleCredentialsConfigured = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
);

export const authOptions: NextAuthOptions = {
  providers: googleCredentialsConfigured
    ? [
        GoogleProvider({
          clientId: process.env.GOOGLE_CLIENT_ID ?? "",
          clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
        }),
      ]
    : [],
  session: { strategy: "jwt" },
};

export { googleCredentialsConfigured };
