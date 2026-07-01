export interface AuthenticatedUser {
  userId: string;
  workspaceId: string;
  email: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}
