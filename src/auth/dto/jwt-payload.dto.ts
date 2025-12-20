// current user info in JWT
export class JwtPayload {
  userId: string;
  accessToken: string;
  role: string;
  iat: number;
  exp: number;
}
