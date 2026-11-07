-- CreateTable
CREATE TABLE "auth_user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "preferredName" TEXT,

    CONSTRAINT "auth_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "auth_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_jwks" (
    "id" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "alg" TEXT,
    "crv" TEXT,

    CONSTRAINT "auth_jwks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_oauthClient" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "clientDiscoveryId" TEXT,
    "disabled" BOOLEAN DEFAULT false,
    "skipConsent" BOOLEAN,
    "enableEndSession" BOOLEAN,
    "subjectType" TEXT,
    "scopes" TEXT[],
    "clientCredentialsScopes" TEXT[],
    "userId" TEXT,
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),
    "name" TEXT,
    "uri" TEXT,
    "icon" TEXT,
    "contacts" TEXT[],
    "tos" TEXT,
    "policy" TEXT,
    "softwareId" TEXT,
    "softwareVersion" TEXT,
    "softwareStatement" TEXT,
    "redirectUris" TEXT[],
    "postLogoutRedirectUris" TEXT[],
    "backchannelLogoutUri" TEXT,
    "backchannelLogoutSessionRequired" BOOLEAN,
    "tokenEndpointAuthMethod" TEXT,
    "applicationType" TEXT,
    "jwks" TEXT,
    "jwksUri" TEXT,
    "grantTypes" TEXT[],
    "responseTypes" TEXT[],
    "requirePKCE" BOOLEAN,
    "dpopBoundAccessTokens" BOOLEAN DEFAULT false,
    "referenceId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "auth_oauthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_oauthResource" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accessTokenTtl" INTEGER,
    "refreshTokenTtl" INTEGER,
    "signingAlgorithm" TEXT,
    "signingKeyId" TEXT,
    "allowedScopes" TEXT[],
    "customClaims" JSONB,
    "dpopBoundAccessTokensRequired" BOOLEAN DEFAULT false,
    "disabled" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),
    "policyVersion" INTEGER DEFAULT 1,
    "metadata" JSONB,

    CONSTRAINT "auth_oauthResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_oauthClientResource" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3),

    CONSTRAINT "auth_oauthClientResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_oauthRefreshToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT NOT NULL,
    "referenceId" TEXT,
    "authorizationCodeId" TEXT,
    "resources" TEXT[],
    "requestedUserInfoClaims" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3),
    "revoked" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "rotationReplayResponse" TEXT,
    "rotationReplayExpiresAt" TIMESTAMP(3),
    "authTime" TIMESTAMP(3),
    "confirmation" JSONB,
    "scopes" TEXT[],

    CONSTRAINT "auth_oauthRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_oauthAccessToken" (
    "id" TEXT NOT NULL,
    "token" TEXT,
    "clientId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT,
    "referenceId" TEXT,
    "authorizationCodeId" TEXT,
    "resources" TEXT[],
    "requestedUserInfoClaims" TEXT[],
    "refreshId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3),
    "revoked" TIMESTAMP(3),
    "confirmation" JSONB,
    "scopes" TEXT[],

    CONSTRAINT "auth_oauthAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_oauthConsent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT,
    "referenceId" TEXT,
    "resources" TEXT[],
    "requestedUserInfoClaims" TEXT[],
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "auth_oauthConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_oauthClientAssertion" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_oauthClientAssertion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "preferredName" TEXT,

    CONSTRAINT "application_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_identity" (
    "id" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "provider_identity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_user_email_key" ON "auth_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_session_token_key" ON "auth_session"("token");

-- CreateIndex
CREATE INDEX "auth_session_userId_idx" ON "auth_session"("userId");

-- CreateIndex
CREATE INDEX "auth_account_userId_idx" ON "auth_account"("userId");

-- CreateIndex
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "auth_oauthClient_clientId_key" ON "auth_oauthClient"("clientId");

-- CreateIndex
CREATE INDEX "auth_oauthClient_userId_idx" ON "auth_oauthClient"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_oauthResource_identifier_key" ON "auth_oauthResource"("identifier");

-- CreateIndex
CREATE INDEX "auth_oauthClientResource_clientId_idx" ON "auth_oauthClientResource"("clientId");

-- CreateIndex
CREATE INDEX "auth_oauthClientResource_resourceId_idx" ON "auth_oauthClientResource"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_oauthClientResource_clientId_resourceId_key" ON "auth_oauthClientResource"("clientId", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_oauthRefreshToken_token_key" ON "auth_oauthRefreshToken"("token");

-- CreateIndex
CREATE INDEX "auth_oauthRefreshToken_clientId_idx" ON "auth_oauthRefreshToken"("clientId");

-- CreateIndex
CREATE INDEX "auth_oauthRefreshToken_sessionId_idx" ON "auth_oauthRefreshToken"("sessionId");

-- CreateIndex
CREATE INDEX "auth_oauthRefreshToken_userId_idx" ON "auth_oauthRefreshToken"("userId");

-- CreateIndex
CREATE INDEX "auth_oauthRefreshToken_authorizationCodeId_idx" ON "auth_oauthRefreshToken"("authorizationCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_oauthAccessToken_token_key" ON "auth_oauthAccessToken"("token");

-- CreateIndex
CREATE INDEX "auth_oauthAccessToken_clientId_idx" ON "auth_oauthAccessToken"("clientId");

-- CreateIndex
CREATE INDEX "auth_oauthAccessToken_sessionId_idx" ON "auth_oauthAccessToken"("sessionId");

-- CreateIndex
CREATE INDEX "auth_oauthAccessToken_userId_idx" ON "auth_oauthAccessToken"("userId");

-- CreateIndex
CREATE INDEX "auth_oauthAccessToken_authorizationCodeId_idx" ON "auth_oauthAccessToken"("authorizationCodeId");

-- CreateIndex
CREATE INDEX "auth_oauthAccessToken_refreshId_idx" ON "auth_oauthAccessToken"("refreshId");

-- CreateIndex
CREATE INDEX "auth_oauthConsent_clientId_idx" ON "auth_oauthConsent"("clientId");

-- CreateIndex
CREATE INDEX "auth_oauthConsent_userId_idx" ON "auth_oauthConsent"("userId");

-- CreateIndex
CREATE INDEX "provider_identity_userId_idx" ON "provider_identity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_identity_issuer_subject_key" ON "provider_identity"("issuer", "subject");

-- AddForeignKey
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauthClient" ADD CONSTRAINT "auth_oauthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauthClientResource" ADD CONSTRAINT "auth_oauthClientResource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "auth_oauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauthClientResource" ADD CONSTRAINT "auth_oauthClientResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "auth_oauthResource"("identifier") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauthRefreshToken" ADD CONSTRAINT "auth_oauthRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "auth_oauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauthRefreshToken" ADD CONSTRAINT "auth_oauthRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "auth_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauthRefreshToken" ADD CONSTRAINT "auth_oauthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauthAccessToken" ADD CONSTRAINT "auth_oauthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "auth_oauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauthAccessToken" ADD CONSTRAINT "auth_oauthAccessToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "auth_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauthAccessToken" ADD CONSTRAINT "auth_oauthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauthAccessToken" ADD CONSTRAINT "auth_oauthAccessToken_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES "auth_oauthRefreshToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauthConsent" ADD CONSTRAINT "auth_oauthConsent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "auth_oauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauthConsent" ADD CONSTRAINT "auth_oauthConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_identity" ADD CONSTRAINT "provider_identity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "application_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Preserve fixture read-only grants and runtime DDL denial.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "auth_user", "auth_session", "auth_account", "auth_verification", "auth_jwks", "auth_oauthClient", "auth_oauthResource", "auth_oauthClientResource", "auth_oauthRefreshToken", "auth_oauthAccessToken", "auth_oauthConsent", "auth_oauthClientAssertion", "application_user", "provider_identity" TO it_runtime;
