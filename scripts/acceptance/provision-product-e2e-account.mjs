import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const email = (process.env.PRODUCT_E2E_EMAIL ?? '').trim().toLowerCase();
const password = process.env.PRODUCT_E2E_PASSWORD ?? '';
const termsVersion = process.env.PRODUCT_E2E_TERMS_VERSION ?? 'terms-2026-06';
const privacyVersion = process.env.PRODUCT_E2E_PRIVACY_VERSION ?? 'privacy-2026-06';

if (!email) throw new Error('PRODUCT_E2E_EMAIL is required');
if (password.length < 12) throw new Error('PRODUCT_E2E_PASSWORD must contain at least 12 characters');

const prisma = new PrismaClient();

try {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const provisioned = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({
      where: { email },
      include: {
        memberships: { orderBy: { createdAt: 'asc' }, take: 1 },
        ownedWorkspaces: { orderBy: { createdAt: 'asc' }, take: 1 },
      },
    });
    const user = existing
      ? await tx.user.update({
          where: { id: existing.id },
          data: {
            passwordHash,
            displayName: 'Production E2E',
            emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
            acceptedTermsVersion: termsVersion,
            acceptedPrivacyVersion: privacyVersion,
            termsAcceptedAt: existing.termsAcceptedAt ?? new Date(),
            privacyAcceptedAt: existing.privacyAcceptedAt ?? new Date(),
          },
        })
      : await tx.user.create({
          data: {
            email,
            passwordHash,
            displayName: 'Production E2E',
            emailVerifiedAt: new Date(),
            acceptedTermsVersion: termsVersion,
            acceptedPrivacyVersion: privacyVersion,
            termsAcceptedAt: new Date(),
            privacyAcceptedAt: new Date(),
          },
        });

    let workspaceId = existing?.memberships[0]?.workspaceId ?? existing?.ownedWorkspaces[0]?.id;
    if (!workspaceId) {
      const workspace = await tx.workspace.create({
        data: {
          ownerId: user.id,
          name: 'Production E2E workspace',
          slug: `production-e2e-${randomBytes(5).toString('hex')}`,
          members: { create: { userId: user.id, role: 'OWNER' } },
        },
      });
      workspaceId = workspace.id;
    }

    await tx.auditLog.create({
      data: {
        userId: user.id,
        workspaceId,
        action: existing ? 'acceptance.account_rotated' : 'acceptance.account_provisioned',
        resource: 'user',
        resourceId: user.id,
      },
    });
    return { userId: user.id, workspaceId, created: !existing };
  });

  process.stdout.write(`${JSON.stringify({ status: 'PASS', email, ...provisioned })}\n`);
} finally {
  await prisma.$disconnect();
}
