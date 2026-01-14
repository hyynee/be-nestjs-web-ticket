import winston, { format, transports } from 'winston';

const customLevels = {
    levels: {
        error: 0,
        warn: 1,
        info: 2,
        http: 3,
        verbose: 4,
        debug: 5,
        silly: 6
    },
    colors: {
        error: 'red',
        warn: 'yellow',
        info: 'green',
        http: 'magenta',
        debug: 'blue'
    }
};
winston.addColors(customLevels.colors);

export const winstonConfig = {
    levels: customLevels.levels,
    transports: [
        // Console logs app
        new transports.File({
            filename: 'logs/combined.log',
            level: 'info',
            maxsize: 20 * 1024 * 1024, // 20MB
            maxFiles: 7,
            format: format.combine(
                format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                format.json()
            )
        }),

        // Error logs
        new transports.File({
            filename: 'logs/error.log',
            level: 'error',
            format: format.combine(
                format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                format.errors({ stack: true }),
                format.json()
            )
        }),

        // Security logs (login failures, locks)
        new transports.File({
            filename: 'logs/security.log',
            level: 'warn',
            maxsize: 10 * 1024 * 1024,
            maxFiles: 30,
            format: format.combine(
                format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                format((info) => info.context === 'security' ? info : false)(),
                format.json()
            )
        })
    ]
};