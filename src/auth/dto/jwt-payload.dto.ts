// current user info in JWT
export class JwtPayload {
  userId: string;
  role: string;
  iat: number;
  exp: number;
  /** Refreshed from DB/cache on every request by JwtStrategy — never trust a stale JWT claim for this. */
  isVerified?: boolean;
}
