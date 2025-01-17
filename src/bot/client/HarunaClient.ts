import { init } from '@sentry/node';
import { AkairoClient, CommandHandler, Flag, InhibitorHandler, ListenerHandler } from 'discord-akairo';
import { Util } from 'discord.js';
import { createServer, Server } from 'http';
import Node from 'lavaqueue';
import { ExtendedRedis } from 'lavaqueue/typings/QueueStore';
import { join } from 'path';
import { Counter, register } from 'prom-client';
import Storage, { ReferenceType } from 'rejects';
import { Connection } from 'typeorm';
import { parse } from 'url';
import { createLogger, format, Logger, transports } from 'winston';
import * as DailyRotateFile from 'winston-daily-rotate-file';
import { Playlist } from '../models/Playlists';
import { Setting } from '../models/Settings';
import database from '../structures/Database';
import TypeORMProvider from '../structures/SettingsProvider';

declare module 'discord-akairo' {
	interface AkairoClient {
		logger: Logger;
		db: Connection;
		settings: TypeORMProvider;
		music: Node;
		redis: ExtendedRedis;
		storage: Storage;
		config: HarunaOptions;
		prometheus: {
			commandCounter: Counter;
		};

		promServer: Server;
	}
}

interface HarunaOptions {
	owner?: string;
	token?: string;
}

export default class HarunaClient extends AkairoClient {
	public logger = createLogger({
		format: format.combine(
			format.timestamp({ format: 'YYYY/MM/DD HH:mm:ss' }),
			format.printf((info: any): string => {
				const { timestamp, level, message, ...rest } = info;
				return `[${timestamp}] ${level}: ${message}${
					Object.keys(rest).length ? `\n${JSON.stringify(rest, null, 2)}` : ''
				}`;
			}),
		),
		transports: [
			new transports.Console({
				format: format.colorize({ level: true }),
				level: 'info',
			}),
			new DailyRotateFile({
				format: format.combine(format.timestamp(), format.json()),
				level: 'debug',
				filename: 'haruna-%DATE%.log',
				maxFiles: '14d',
			}),
		],
	});

	public db!: Connection;

	public settings!: TypeORMProvider;

	public music = new Node({
		userID: process.env.ID!,
		password: process.env.LAVALINK_PASSWORD!,
		hosts: {
			rest: process.env.LAVALINK_REST!,
			ws: process.env.LAVALINK_WS!,
			redis: process.env.REDIS
				? {
						port: 6379,
						host: process.env.REDIS,
						db: 0,
				  }
				: undefined,
		},
		send: async (guild, packet): Promise<void> => {
			const shardGuild = this.guilds.get(guild);
			if (shardGuild) return shardGuild.shard.send(packet);
			return Promise.resolve();
		},
	});

	public redis = this.music.queues.redis;

	public storage = new Storage(this.redis);

	public commandHandler = new CommandHandler(this, {
		directory: join(__dirname, '..', 'commands'),
		prefix: ['🎶', '🎵', '🎼', '🎹', '🎺', '🎻', '🎷', '🎸', '🎤', '🎧', '🥁'],
		aliasReplacement: /-/g,
		allowMention: true,
		handleEdits: true,
		commandUtil: true,
		commandUtilLifetime: 3e5,
		defaultCooldown: 3000,
		argumentDefaults: {
			prompt: {
				modifyStart: (_, str): string => `${str}\n\nType \`cancel\` to cancel the command.`,
				modifyRetry: (_, str): string => `${str}\n\nType \`cancel\` to cancel the command.`,
				timeout: 'Guess you took too long, the command has been cancelled.',
				ended: "More than 3 tries and you still didn't quite get it. The command has been cancelled",
				cancel: 'The command has been cancelled.',
				retries: 3,
				time: 30000,
			},
			otherwise: '',
		},
	});

	public inhibitorHandler = new InhibitorHandler(this, { directory: join(__dirname, '..', 'inhibitors') });

	public listenerHandler = new ListenerHandler(this, { directory: join(__dirname, '..', 'listeners') });

	public config: HarunaOptions;

	public prometheus = {
		messagesCounter: new Counter({ name: 'haruna_messages_total', help: 'Total number of messages Haruna has seen' }),
		commandCounter: new Counter({ name: 'haruna_commands_total', help: 'Total number of commands used' }),
		register,
	};

	public promServer = createServer((req, res): void => {
		if (parse(req.url!).pathname === '/metrics') {
			res.writeHead(200, { 'Content-Type': this.prometheus.register.contentType });
			res.write(this.prometheus.register.metrics());
		}
		res.end();
	});

	public constructor(config: HarunaOptions) {
		super(
			{ ownerID: config.owner },
			{
				disableEveryone: true,
				disabledEvents: ['TYPING_START'],
			},
		);

		this.on(
			'raw',
			async (packet: any): Promise<void> => {
				switch (packet.t) {
					case 'VOICE_STATE_UPDATE':
						if (packet.d.user_id !== process.env.ID) return;
						this.music.voiceStateUpdate(packet.d);
						const players: { guild_id: string, channel_id?: string }[] | null = await this.storage.get('players', { type: ReferenceType.ARRAY }); // eslint-disable-line
						let index = 0; // eslint-disable-line
						if (Array.isArray(players)) {
							index = players.findIndex((player): boolean => player.guild_id === packet.d.guild_id);
						}
						if (((!players && !index) || index < 0) && packet.d.channel_id) {
							this.storage.upsert('players', [{ guild_id: packet.d.guild_id, channel_id: packet.d.channel_id }]);
						} else if (players && typeof index !== 'undefined' && index >= 0 && !packet.d.channel_id) {
							players.splice(index, 1);
							await this.storage.delete('players');
							if (players.length) await this.storage.set('players', players);
						}
						break;
					case 'VOICE_SERVER_UPDATE':
						this.music.voiceServerUpdate(packet.d);
						break;
					case 'MESSAGE_CREATE':
						this.prometheus.messagesCounter.inc();
						break;
					default:
						break;
				}
			},
		);

		this.commandHandler.resolver.addType('playlist', async (message, phrase) => {
			if (!phrase) return Flag.fail(phrase);
			phrase = Util.cleanContent(phrase.toLowerCase(), message);
			const playlistRepo = this.db.getRepository(Playlist);
			const playlist = await playlistRepo.findOne({ name: phrase, guild: message.guild!.id });

			return playlist || Flag.fail(phrase);
		});
		this.commandHandler.resolver.addType('existingPlaylist', async (message, phrase) => {
			if (!phrase) return Flag.fail(phrase);
			phrase = Util.cleanContent(phrase.toLowerCase(), message);
			const playlistRepo = this.db.getRepository(Playlist);
			const playlist = await playlistRepo.findOne({ name: phrase, guild: message.guild!.id });

			return playlist ? Flag.fail(phrase) : phrase;
		});

		this.config = config;

		if (process.env.SENTRY) {
			init({
				dsn: process.env.SENTRY,
				environment: process.env.NODE_ENV,
				release: process.env.VERSION!,
			});
		} else {
			process.on('unhandledRejection', (err: any) =>
				this.logger.error(`[UNHANDLED REJECTION] ${err.message}`, err.stack),
			);
		}
	}

	private async _init(): Promise<void> {
		this.commandHandler.useInhibitorHandler(this.inhibitorHandler);
		this.commandHandler.useListenerHandler(this.listenerHandler);
		this.listenerHandler.setEmitters({
			commandHandler: this.commandHandler,
			inhibitorHandler: this.inhibitorHandler,
			listenerHandler: this.listenerHandler,
		});

		this.commandHandler.loadAll();
		this.inhibitorHandler.loadAll();
		this.listenerHandler.loadAll();

		this.db = database.get('haruna');
		await this.db.connect();
		this.settings = new TypeORMProvider(this.db.getRepository(Setting));
		await this.settings.init();
	}

	public async start(): Promise<string> {
		await this._init();
		return this.login(this.config.token);
	}
}
