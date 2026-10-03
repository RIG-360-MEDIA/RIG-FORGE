import { type NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withoutOrgScope } from '@/lib/tenant-context'
import { hashPassword } from '@/lib/auth'
import { authenticateCapable } from '@/lib/authz'
import { can } from '@/lib/permissions'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { encryptSecret } from '@/lib/secret-box'
import crypto from 'crypto'

function generateSecurePassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghjkmnpqrstuvwxyz'
  const digits = '23456789'
  const symbols = '#$!@%&'
  const all = upper + lower + digits + symbols
  const bytes = crypto.randomBytes(16)
  let password = ''
  // Ensure at least one of each type
  password += upper[bytes[0] % upper.length]
  password += lower[bytes[1] % lower.length]
  password += digits[bytes[2] % digits.length]
  password += symbols[bytes[3] % symbols.length]
  for (let i = 4; i < 16; i++) {
    password += all[bytes[i] % all.length]
  }
  // Shuffle
  return password.split('').sort(() => (crypto.randomBytes(1)[0] ?? 128) / 256 - 0.5).join('')
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = await authenticateCapable(request)
    if (!payload || !can(payload.capabilities, 'members.manage')) return errorResponse('Admin access required', 403)

    let body: unknown
    try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }
    const { name, email, role } = body as Record<string, unknown>

    if (!name || typeof name !== 'string' || name.trim().length < 2)
      return errorResponse('Name is required (min 2 chars)', 400)
    if (!email || typeof email !== 'string' || !email.includes('@'))
      return errorResponse('Valid email is required', 400)
    if (!role || !['ADMIN', 'EMPLOYEE'].includes(role as string))
      return errorResponse('Role must be ADMIN or EMPLOYEE', 400)

    // ── Role restriction: only SUPER_ADMIN can create ADMIN accounts ──────────
    if (role === 'ADMIN' && payload.role !== 'SUPER_ADMIN') {
      return errorResponse('Only Super Admin can create Admin accounts', 403)
    }

    // ── No one can create SUPER_ADMIN accounts via this route ─────────────────
    if (role === 'SUPER_ADMIN') {
      return errorResponse('Super Admin accounts cannot be created via this route', 403)
    }

    const normalizedEmail = email.toLowerCase().trim()
    // Email is unique across EVERY company (it is the login identifier), so the
    // check has to be global; a company-filtered lookup would miss an address
    // used elsewhere and the insert would then fail on the unique index.
    // Only a yes/no comes back — no other company's data is returned.
    const existing = await withoutOrgScope(() =>
      prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } }),
    )
    if (existing) return errorResponse('Email already in use', 409)

    const temporaryPassword = generateSecurePassword()
    const passwordHash = await hashPassword(temporaryPassword)

    await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        passwordHash,
        role: role as 'ADMIN' | 'EMPLOYEE',
        isOnboarding: false,          // pre-approved — no approval step needed
        currentStatus: 'NOT_WORKING',
        tempPassword: encryptSecret(temporaryPassword),  // encrypted at rest; admins retrieve via the (decrypting) detail endpoint
        mustChangePassword: true,         // user must change on first login
      },
    })

    return successResponse({ email: normalizedEmail, temporaryPassword }, 201)
  } catch (error) {
    console.error('[POST /api/admin/generate-user]', error)
    return errorResponse('Server error', 500)
  }
}
