import {
	BadRequestException,
	ConflictException,
	Injectable,
	InternalServerErrorException,
	NotFoundException,
	UnauthorizedException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Int } from '@nestjs/graphql'
import { verify } from 'argon2'
import type { Request } from 'express'

// import { TOTP } from 'otpauth'

import { PrismaService } from '@/src/core/prisma/prisma.service'
import { RedisService } from '@/src/core/redis/redis.service'
import { getSessionMetadata } from '@/src/shared/utils/session-metadata.util'

// import { destroySession, saveSession } from '@/src/shared/utils/session.util'

// import { VerificationService } from '../verification/verification.service'

import { LoginInput } from './inputs/login.input'

@Injectable()
export class SessionService {
	public constructor(
		private readonly prismaService: PrismaService,
		private readonly redisService: RedisService,
		private readonly configService: ConfigService
		// private readonly verificationService: VerificationService
	) {}

	public async findByUser(req: Request) {
		const userId = req.session.userId

		if (!userId) {
			throw new NotFoundException('Пользователь не обнаружен в сессии')
		}

		const keys = await this.redisService.keys('*')

		const userSessions: Array<{
			createdAt: number
			userId: string
			id: string
		}> = []

		for (const key of keys) {
			const sessionData = await this.redisService.get(key)

			if (sessionData) {
				const session = JSON.parse(sessionData)

				if (session.userId === userId) {
					userSessions.push({
						...session,
						id: key.split(':')[1]
					})
				}
			}
		}

		userSessions.sort((a, b) => b.createdAt - a.createdAt)

		return userSessions.filter(session => session.id !== req.session.id)
	}

	public async findCurrent(req: Request) {
		const sessionId = req.session.id

		const sessionFolder =
			this.configService.getOrThrow<string>('SESSION_FOLDER')

		if (!sessionFolder) {
			throw new Error('SESSION_FOLDER не установлен в конфигурации')
		}

		const sessionKey = `${sessionFolder}${sessionId}`
		const sessionData = await this.redisService.get(sessionKey)

		if (!sessionData) {
			throw new NotFoundException('Сессия не найдена')
		}

		const session = JSON.parse(sessionData)

		return {
			...session,
			id: sessionId
		}
	}

	public async login(req: Request, input: LoginInput, userAgent: string) {
		const { login, password } = input

		console.log(
			'Начало процесса входа. Поиск пользователя в базе данных...'
		) // Логирование

		const user = await this.prismaService.user.findFirst({
			where: {
				OR: [
					{ username: { equals: login } },
					{ email: { equals: login } }
				]
			}
		})

		if (!user) {
			console.error('Пользователь не найден в базе данных.') // Логирование ошибки
			throw new NotFoundException('Пользователь не найден')
		}

		console.log('Пользователь найден. Проверка пароля...') // Логирование

		const isValidPassword = await verify(user.password, password)

		if (!isValidPassword) {
			console.error('Неверный пароль.') // Логирование ошибки
			throw new UnauthorizedException('Неверный пароль')
		}

		console.log('Пароль верный. Начало создания сессии...') // Логирование
		const metadata = getSessionMetadata(req, userAgent)
		return new Promise((resolve, reject) => {
			req.session.createdAt = new Date()
			req.session.userId = user.id
			req.session.metadata = metadata

			console.log('Данные сессии установлены:', {
				createdAt: req.session.createdAt,
				userId: req.session.userId
			}) // Логирование данных сессии

			console.log('Попытка сохранить сессию...') // Логирование

			req.session.save(err => {
				if (err) {
					console.error('Ошибка при сохранении сессии:', err) // Логирование ошибки
					return reject(
						new InternalServerErrorException(
							'Не удалось сохранить сессию'
						)
					)
				}

				console.log('Сессия успешно сохранена.') // Логирование успешного сохранения
				console.log('Данные сессии после сохранения:', {
					createdAt: req.session.createdAt,
					userId: req.session.userId
				}) // Логирование данных сессии после сохранения
				console.log('Заголовки ответа сервера:', req.res?.getHeaders()) // <-- СЮДА
				resolve(user)
			})
		})

		// if (!user.isEmailVerified) {
		// 	await this.verificationService.sendVerificationToken(user)

		// 	throw new BadRequestException(
		// 		'Аккаунт не верифицирован. Пожалуйста, проверьте свою почту для подтверждения'
		// 	)
		// }

		// if (user.isTotpEnabled) {
		// 	if (!pin) {
		// 		return {
		// 			message: 'Необходим код для завершения авторизации'
		// 		}
		// 	}

		// 	const totp = new TOTP({
		// 		issuer: 'TeaStream',
		// 		label: `${user.email}`,
		// 		algorithm: 'SHA1',
		// 		digits: 6,
		// 		secret: user.totpSecret
		// 	})

		// 	const delta = totp.validate({ token: pin })

		// 	if (delta === null) {
		// 		throw new BadRequestException('Неверный код')
		// 	}
		// }

		// const metadata = getSessionMetadata(req, userAgent)

		// return saveSession(req, user, metadata)
	}

	public async logout(req: Request) {
		return new Promise((resolve, reject) => {
			/////////////////////////////

			const sessionId = req.session.id
			const sessionKey = `${this.configService.getOrThrow<string>('SESSION_FOLDER')}${sessionId}`

			// Удаляем сессию из Redis
			this.redisService.del(sessionKey, err => {
				if (err) {
					console.error('Ошибка при удалении сессии из Redis:', err)
					return reject(
						new InternalServerErrorException(
							'Не удалось удалить сессию из Redis'
						)
					)
				}

				console.log('Сессия успешно удалена из Redis.')

				///////////////
				console.log(
					'Попытка выхода пользователя. Текущая сессия:',
					req.session
				)
				req.session.destroy(err => {
					if (err) {
						return reject(
							new InternalServerErrorException(
								'Не удалось завершить сессию'
							)
						)
					}
					console.log('Сессия успешно удалена.')
					req.res?.clearCookie(
						this.configService.getOrThrow<string>('SESSION_NAME')
					)
					const sessionName =
						this.configService.getOrThrow<string>('SESSION_NAME')
					console.log(`Cookie с именем ${sessionName} очищен.`)
					resolve(true)
				})
			})
		})
		// 	return destroySession(req, this.configService)
		// }
	}
	public async clearSession(req: Request) {
		req.res?.clearCookie(
			this.configService.getOrThrow<string>('SESSION_NAME')
		)

		return true
	}

	public async remove(req: Request, id: string) {
		if (req.session.id === id) {
			throw new ConflictException('Текущую сессию удалить нельзя')
		}

		await this.redisService.del(
			`${this.configService.getOrThrow<string>('SESSION_FOLDER')}${id}`
		)

		return true
	}
}
