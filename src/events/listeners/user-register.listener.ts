import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { User } from "@src/schemas/user.schema";
import { MailService } from "@src/services/mail.service";


@Injectable()
export class UserRegisterListener {
    private readonly logger = new Logger(UserRegisterListener.name);
    constructor(
        private readonly mail: MailService,
    ) { }

    @OnEvent('user.registered')
    async handleUserRegisteredEvent(payload: User) {
        try {
            const { email, fullName } = payload;
            await this.mail.sendRegisterEmail(email, fullName);
        } catch (error) {
            this.logger.error('Send mail failed', error);
        }
    }

}