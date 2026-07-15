import { plainToInstance } from "class-transformer";
import {
  registerDecorator,
  validateSync,
  ValidationArguments,
  ValidationOptions,
} from "class-validator";
import { QueueJobType } from "./queue-job-type.enum";
import {
  BookingConfirmationPayloadDto,
  ExportCheckInZonesJobPayloadDto,
  ExportTicketsJobPayloadDto,
  RefundFailureAlertPayloadDto,
  SendPasswordResetPayloadDto,
  SendRegisterEmailPayloadDto,
  SendVerificationEmailPayloadDto,
} from "./job-payloads.dto";

const PAYLOAD_DTO_BY_TYPE: Record<QueueJobType, new () => object> = {
  [QueueJobType.SEND_REGISTER_EMAIL]: SendRegisterEmailPayloadDto,
  [QueueJobType.SEND_VERIFICATION_EMAIL]: SendVerificationEmailPayloadDto,
  [QueueJobType.SEND_PASSWORD_RESET]: SendPasswordResetPayloadDto,
  [QueueJobType.SEND_BOOKING_CONFIRMATION]: BookingConfirmationPayloadDto,
  [QueueJobType.FINALIZE_TICKET_DELIVERY]: BookingConfirmationPayloadDto,
  [QueueJobType.REFUND_FAILURE_ALERT]: RefundFailureAlertPayloadDto,
  [QueueJobType.EXPORT_TICKETS]: ExportTicketsJobPayloadDto,
  [QueueJobType.EXPORT_CHECKIN_ZONES]: ExportCheckInZonesJobPayloadDto,
};

/**
 * Validates `payload` against the DTO registered for the sibling `type` field,
 * so an admin-submitted job can't reach the queue processor with a shape it
 * doesn't expect. Unknown/extra fields on the payload are rejected too.
 */
export function IsValidJobPayload(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isValidJobPayload",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const type = (args.object as { type?: QueueJobType }).type;
          if (!type || !(type in PAYLOAD_DTO_BY_TYPE)) {
            // Unknown/missing type is already reported by @IsEnum on `type`.
            return true;
          }
          if (value === null || typeof value !== "object") {
            return false;
          }

          const PayloadDto = PAYLOAD_DTO_BY_TYPE[type];
          const instance = plainToInstance(PayloadDto, value);
          const errors = validateSync(instance as object, {
            whitelist: true,
            forbidNonWhitelisted: true,
          });
          return errors.length === 0;
        },
        defaultMessage(args: ValidationArguments): string {
          const type = (args.object as { type?: QueueJobType }).type;
          return `payload does not match the expected shape for job type "${type}"`;
        },
      },
    });
  };
}
