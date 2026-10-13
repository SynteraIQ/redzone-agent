import GitHubProvider from "next-auth/providers/github";
import type { NextAuthOptions } from "next-auth";

const githubOAuthConfigured = Boolean(
  process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET,
);

export const authOptions: NextAuthOptions = {
  providers: githubOAuthConfigured
    ? [
        GitHubProvider({
          clientId: process.env.GITHUB_CLIENT_ID ?? "",
          clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
        }),
      ]
    : [],
  session: { strategy: "jwt" },
  callbacks: {
    async session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
};

export { githubOAuthConfigured };
