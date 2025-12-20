import { BadRequestException, Injectable } from '@nestjs/common';
import config from '@src/config/config';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { Booking } from '@src/schemas/booking.schema';
import { Model, Types } from 'mongoose';
import { InjectModel } from '@nestjs/mongoose';
import { BookingService } from '@src/booking/booking.service';
import { Payment } from '@src/schemas/payment.schema';
import { Zone } from '@src/schemas/zone.schema';
import { TicketService } from '@src/ticket/ticket.service';
import { MailService } from '@src/services/mail.services';

@Injectable()
export class PaymentService {
    private stripe: Stripe;

    constructor(
        @InjectModel(Payment.name) private paymentModel: Model<any>,
        @InjectModel(Booking.name) private bookingModel: Model<Booking>,
        @InjectModel(Zone.name) private zoneModel: Model<Zone>,
        private ticketService: TicketService,
        private mailService: MailService
    ) {
        this.stripe = new Stripe(`${config.STRIPE_SECRET_KEY}`)
    }

    async createCheckoutSession(userId: string, bookingCode: string) {
        const booking = await this.bookingModel
            .findOne({
                bookingCode: bookingCode,
                userId: userId,
                isDeleted: false
            })
            .populate('eventId', 'title thumbnail location startDate endDate')
            .populate('zoneId', 'name price')
            .populate('areaId', 'name');

        if (!booking) {
            throw new BadRequestException('Booking not found or unauthorized');
        }

        if (booking.status !== "pending") {
            throw new BadRequestException("Booking is completed or cancelled");
        }

        if (booking.paymentStatus === "paid") {
            throw new BadRequestException("Booking already paid");
        }

        // Check booking expiration
        if (new Date() > booking.expiresAt) {
            booking.status = "expired";
            await booking.save();
            throw new BadRequestException("Booking has expired");
        }

        const event = booking.eventId as any;
        const zone = booking.zoneId as any;

        const thumbnailUrl = event.thumbnail ||
            "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=400";

        const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
            {
                price_data: {
                    currency: "vnd",
                    product_data: {
                        name: `${event.title} - ${zone.name}`,
                        description: booking.seats.length > 0
                            ? `Ghế: ${booking.seats.join(", ")}`
                            : `Số lượng: ${booking.quantity} vé`,
                        images: [thumbnailUrl],
                        metadata: {
                            eventId: event._id.toString(),
                            zoneId: zone._id.toString(),
                        },
                    },
                    unit_amount: Math.round(booking.pricePerTicket),
                },
                quantity: booking.seats.length || booking.quantity,
            },
        ];
        const session = await this.stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            mode: "payment",
            customer_email: booking.customerEmail,

            shipping_address_collection: {
                allowed_countries: ['US', 'CA', 'KE', 'VN'],
            },
            shipping_options: [
                {
                    shipping_rate_data: {
                        type: 'fixed_amount',
                        fixed_amount: {
                            amount: 0,
                            currency: 'vnd',
                        },
                        display_name: 'Free shipping',
                        delivery_estimate: {
                            minimum: {
                                unit: 'business_day',
                                value: 5,
                            },
                            maximum: {
                                unit: 'business_day',
                                value: 7,
                            },
                        },
                    },
                },
                {
                    shipping_rate_data: {
                        type: 'fixed_amount',
                        fixed_amount: {
                            amount: 30000,
                            currency: 'vnd',
                        },
                        display_name: 'Next day air',
                        // Delivers in exactly 1 business day
                        delivery_estimate: {
                            minimum: {
                                unit: 'business_day',
                                value: 1,
                            },
                            maximum: {
                                unit: 'business_day',
                                value: 1,
                            },
                        },
                    },
                },
            ],
            line_items: lineItems,
            phone_number_collection: {
                enabled: true,
            },
            success_url: `${config.FRONTEND_URL}/my-bookings`,
            cancel_url: `${config.FRONTEND_URL}/booking/cancel?booking_code=${booking.bookingCode}`,
            metadata: {
                userId: userId,
                bookingCode: booking.bookingCode,
                bookingId: (booking._id as Types.ObjectId).toString(),
            },
            expires_at: Math.floor(booking.expiresAt.getTime() / 1000),
        });
        return {
            status: 200,
            message: "Checkout session created successfully",
            checkoutUrl: session.url,
        }
    }
    verifyWebhook(rawBody: Buffer, signature: string): Stripe.Event {
        const endpointSecret = config.STRIPE_WEBHOOK_SECRET;
        try {
            const event = this.stripe.webhooks.constructEvent(
                rawBody,
                signature,
                endpointSecret
            );
            return event;
        } catch (err) {
            throw new BadRequestException(`Webhook Error: ${err.message}`);
        }
    }

    async handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent) {
        console.log('paymentIntent', paymentIntent);
    }


    async handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
        try {
            const { userId, bookingCode, bookingId } = session.metadata || {};

            if (!userId || !bookingCode || !bookingId) {
                throw new Error('Missing metadata in session');
            }
            const updatedBooking = await this.bookingModel.findOneAndUpdate(
                {
                    _id: bookingId,
                    bookingCode: bookingCode,
                    paymentStatus: { $ne: 'paid' },
                    isDeleted: false
                },
                {
                    status: 'confirmed',
                    paymentStatus: 'paid',
                    paidAt: new Date(),
                    stripePaymentIntentId: session.payment_intent as string || session.id,
                    customerPhone: session.customer_details?.phone,
                    customerName: session.customer_details?.name
                },
                {
                    new: true,
                    select: 'zoneId quantity bookingCode areaId eventId seats '
                }
            )
                .populate('eventId', 'title location startDate endDate')
                .populate('zoneId', 'name')
                .populate('areaId', 'name');


            if (!updatedBooking) {
                console.log(`Booking ${bookingCode} already processed, skipping...`);
                return;
            }

            if (updatedBooking.quantity > 0) {
                await this.zoneModel.findByIdAndUpdate(
                    updatedBooking.zoneId,
                    { $inc: { soldCount: updatedBooking.quantity } }
                );
            }

            await this.paymentModel.findOneAndUpdate(
                { stripePaymentIntentId: session.payment_intent || session.id },
                {
                    userId: userId,
                    bookingId: bookingId,
                    amount: session.amount_total,
                    currency: session.currency || 'vnd',
                    status: 'succeeded',
                    paidAt: new Date(),
                    paymentMethod: 'card',
                    stripePaymentIntentId: session.payment_intent || session.id,
                    metadata: {
                        sessionId: session.id,
                        customerEmail: session.customer_details?.email,
                        customerName: session.customer_details?.name,
                        customerPhone: session.customer_details?.phone
                    }
                },
                { upsert: true, new: true }
            );
            // Tạo Tickets với QR Code
            const tickets = await this.ticketService.createTicketsFromBooking(bookingCode);
            // map data ticket
            const ticketMailData = tickets.map(ticket => ({
                ticketCode: ticket.ticketCode,
                seatNumber: ticket.seatNumber || null,
                qrCode: ticket.qrCode || null,
            }));
            // mail xác nhận đặt vé
            await this.mailService.sendBookingConfirmation({
                email: session.customer_details?.email!,
                customerName: session.customer_details?.name || 'Khách hàng',
                bookingCode: updatedBooking.bookingCode,
                eventTitle: (updatedBooking.eventId as any).title,
                eventLocation: (updatedBooking.eventId as any).location,
                eventDate: (updatedBooking.eventId as any).startDate,
                zoneName: (updatedBooking.zoneId as any).name,
                seats: updatedBooking.seats || [],
                quantity: updatedBooking.quantity,
                totalPrice: session.amount_total || 0,
                currency: session.currency || 'vnd',
                tickets: ticketMailData,
            });

        } catch (error) {
            console.error(`Error handling checkout session:`, error);
            throw error;
        }
    }
    async getPaymentHistory(userId: string) {
        const payments = await this.paymentModel
            .find({ userId, isDeleted: false })
            .populate({
                path: 'bookingId',
                populate: [
                    { path: 'eventId', select: 'title location startDate' },
                    { path: 'zoneId', select: 'name price' },
                ],
            })
            .sort({ createdAt: -1 });

        return {
            success: true,
            data: payments,
        };
    }

}
