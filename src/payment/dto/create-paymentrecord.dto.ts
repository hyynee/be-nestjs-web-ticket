import { Types } from 'mongoose';

export class CreatePaymentRecordDto {
    bookingId: Types.ObjectId;
    userId: Types.ObjectId;
    eventId?: Types.ObjectId;
    stripePaymentIntentId: string;
    amount: number;
    currency?: string;
    paymentMethod?: string;
    status?: string;
    metadata?: Record<string, any>;
    createAt?: Date;
    updateAt?: Date;
}