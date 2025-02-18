import {
	BadRequestException,
	Injectable,
	NotAcceptableException,
	NotFoundException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { verify } from 'argon2'
import type { Request } from 'express'

import { TokenType, type User } from '@/prisma/generated'
import { PrismaService } from '@/src/core/prisma/prisma.service'
import { RedisService } from '@/src/core/redis/redis.service'
import { generateToken } from '@/src/shared/utils/generate-token.util'
import { getSessionMetadata } from '@/src/shared/utils/session-metadata.util'
import { destroySession } from '@/src/shared/utils/session.util'

import { MailService } from '../../libs/mail/mail.service'
import { TelegramService } from '../../libs/telegram/telegram.service'

import { DeactivateAccountInput } from './inputs/deactivate-account.input'

@Injectable()
export class DeactivateService {
	public constructor(
		private readonly prismaService: PrismaService,
		private readonly redisService: RedisService,
		private readonly configService: ConfigService,
		private readonly mailSerivce: MailService,
		private readonly telegramService: TelegramService
	) {}

	public async deactivate(
		req: Request,
		input: DeactivateAccountInput,
		user: User,
		userAgent: string
	) {
		const { email, password, pin } = input

		if (user.email !== email) {
			throw new BadRequestException('Неверная почта')
		}

		const isValidPassword = await verify(user.password, password)

		if (!isValidPassword) {
			throw new BadRequestException('Неверный пароль')
		}

		if (!pin) {
			await this.sendDeactivateToken(req, user, userAgent)

			return { message: 'Требуется код подтверждения' }
		}

		await this.validateDeactivateToken(req, pin)

		return { user }
	}

	private async validateDeactivateToken(req: Request, token: string) {
		const existingToken = await this.prismaService.token.findUnique({
			where: {
				token,
				type: TokenType.DEACTIVATE_ACCOUNT
			}
		})

		if (!existingToken) {
			throw new NotFoundException('Токен не найден')
		}

		const hasExpired = new Date(existingToken.expiresIn) < new Date()

		if (hasExpired) {
			throw new BadRequestException('Токен истёк')
		}

		const user = await this.prismaService.user.update({
			where: {
				id: existingToken.userId ?? undefined
			},
			data: {
				isDeactivated: true,
				deactivatedAt: new Date()
			}
		})

		await this.prismaService.token.delete({
			where: {
				id: existingToken.id,
				type: TokenType.DEACTIVATE_ACCOUNT
			}
		})

		await this.clearSessions(user.id)

		return destroySession(req, this.configService)
	}

	private async sendDeactivateToken(
		req: Request,
		input: DeactivateAccountInput,
		// user: User & {
		// notificationSettings?: {
		// 	telegramNotifications?: boolean
		// 	siteNotifications?: boolean
		// }
		// }, // Типизируем user для notificationSettings,
		userAgent: string
	) {
		const { email } = input
		const user = await this.prismaService.user.findUnique({
			where: {
				email
			},
			include: {
				notificationSettings: true
			}
		})
		if (!user) {
			throw new NotAcceptableException('Пользователь не найден')
		}
		const deactivateToken = await generateToken(
			this.prismaService,
			user,
			TokenType.DEACTIVATE_ACCOUNT,
			false
		)

		const metadata = getSessionMetadata(req, userAgent)

		await this.mailSerivce.sendDeactivateToken(
			user.email,
			deactivateToken.token,
			metadata
		)

		if (user.notificationSettings?.siteNotifications) {
			await this.mailSerivce.sendDeactivateToken(
				user.email,
				deactivateToken.token,
				metadata
			)
		}

		if (
			user.notificationSettings?.telegramNotifications &&
			user.telegramId
		) {
			await this.telegramService.sendDeactivateToken(
				user.telegramId,
				deactivateToken.token,
				metadata
			)
			// await this.telegramService.sendAccountDeletion(user.telegramId)
		}

		return true
	}

	private async clearSessions(userId: string) {
		const keys = await this.redisService.keys('*')

		for (const key of keys) {
			const sessionData = await this.redisService.get(key)

			if (sessionData) {
				const session = JSON.parse(sessionData)

				if (session.userId === userId) {
					await this.redisService.del(key)
				}
			}
		}
	}
}
