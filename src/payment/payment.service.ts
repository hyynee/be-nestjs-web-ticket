import { BadRequestException, Injectable } from '@nestjs/common';
import config from '@src/config/config';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { Booking } from '@src/schemas/booking.schema';
import { Model, Types } from 'mongoose';
import { InjectModel } from '@nestjs/mongoose';
import { Payment } from '@src/schemas/payment.schema';
import { Zone } from '@src/schemas/zone.schema';
import { TicketService } from '@src/ticket/ticket.service';
import { MailService } from '@src/services/mail.service';
import * as paypal from '@paypal/checkout-server-sdk';

@Injectable()
export class PaymentService {
    private stripe: Stripe;
    private paypal: any;

    constructor(
        @InjectModel(Payment.name) private paymentModel: Model<any>,
        @InjectModel(Booking.name) private bookingModel: Model<Booking>,
        @InjectModel(Zone.name) private zoneModel: Model<Zone>,
        private ticketService: TicketService,
        private mailService: MailService
    ) {
        this.stripe = new Stripe(`${config.STRIPE_SECRET_KEY}`)
        const env_paypal = new paypal.core.SandboxEnvironment(
            config.PAYPAL_CLIENT_ID,
            config.PAYPAL_CLIENT_SECRET
        );
        this.paypal = new paypal.core.PayPalHttpClient(env_paypal);
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

    async createPaypalTransaction(userId: string, bookingCode: string) {
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
        if (new Date() > booking.expiresAt) {
            booking.status = "expired";
            await booking.save();
            throw new BadRequestException("Booking has expired");
        }

        const request = new paypal.orders.OrdersCreateRequest();
        request.prefer("return=representation");

        const amountUSD = (booking.totalPrice / 23000).toFixed(2);

        request.requestBody({
            intent: 'CAPTURE',
            purchase_units: [{
                reference_id: booking.bookingCode,
                description: `Ticket for ${(booking.eventId as any).title}`,
                amount: {
                    currency_code: 'USD',
                    value: amountUSD
                }
            }],
            application_context: {
                return_url: `${config.FRONTEND_URL}/payment/paypal-success?bookingCode=${booking.bookingCode}`,
                cancel_url: `${config.FRONTEND_URL}/payment/paypal-cancel?bookingCode=${booking.bookingCode}`,
            }
        });

        try {
            const response = await this.paypal.execute(request);
            const order = response.result;

            await this.paymentModel.create({
                userId: userId,
                bookingId: booking._id,
                eventId: booking.eventId,
                amount: booking.totalPrice,
                currency: 'VND',
                status: 'pending',
                paymentMethod: 'paypal',
                paypalOrderId: order.id,
                metadata: {
                    bookingCode: bookingCode,
                    eventTitle: (booking.eventId as any).title,
                    amountUSD: amountUSD
                }
            });
            // Trả về order ID cho frontend
            const approveLink = order.links.find(link => link.rel === 'approve');
            return {
                status: 200,
                message: "PayPal order created successfully",
                paypalOrderId: order.id,
                approvalUrl: approveLink?.href,
                amountUSD: amountUSD,
                bookingDetails: {
                    bookingCode: booking.bookingCode,
                    amount: booking.totalPrice,
                    amountUSD: amountUSD,
                    currency: 'VND',
                    customerEmail: booking.customerEmail,
                    customerName: booking.customerName,
                    customerPhone: booking.customerPhone,
                }
            }
        } catch (error) {
            console.error('PayPal error:', error);
            throw new BadRequestException('Failed to create PayPal order');
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
                    { $inc: { confirmedSoldCount: updatedBooking.quantity } }
                );
            }

            await this.paymentModel.findOneAndUpdate(
                { stripePaymentIntentId: session.payment_intent || session.id },
                {
                    userId: userId,
                    bookingId: bookingId,
                    eventId: updatedBooking.eventId,
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
            const tickets = await this.ticketService.createTicketsFromBooking(bookingCode);
            const ticketMailData = tickets.map(ticket => ({
                ticketCode: ticket.ticketCode,
                seatNumber: ticket.seatNumber,
                qrCode: ticket.qrCode || '',
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

    async payCheckout(id: string) {
        let booking;
        if (Types.ObjectId.isValid(id)) {
            booking = await this.bookingModel.findById(id);
        } else if (id.startsWith('BK')) {
            booking = await this.bookingModel.findOne({ bookingCode: id });
        } else {
            const payment = await this.paymentModel.findOne({
                $or: [
                    { paypalOrderId: id },
                    { stripePaymentIntentId: id }
                ]
            }).populate('bookingId');
            if (payment?.bookingId) {
                booking = payment.bookingId as any;
            }
        }
        if (!booking) {
            throw new BadRequestException('Booking not found');
        }
        if (booking.paymentStatus === "paid") {
            throw new BadRequestException("Booking already paid");
        }
        booking.paymentStatus = "paid";
        booking.status = "confirmed";
        booking.paidAt = new Date();
        if (booking.quantity > 0) {
            await this.zoneModel.findByIdAndUpdate(
                booking.zoneId,
                { $inc: { confirmedSoldCount: booking.quantity } }
            );
        }
        await booking.save();
        return {
            status: 200,
            message: "Booking paid successfully",
        };
    }

    async finalizePaypalTransaction(orderId: string) {
        const payment = await this.paymentModel.findOne({ paypalOrderId: orderId });
        if (!payment) {
            throw new BadRequestException('Payment record not found');
        }
        if (payment.status === 'succeeded') {
            return { status: 200, message: 'Payment already finalized' };
        }
        try {
            const captureRequest = new paypal.orders.OrdersCaptureRequest(orderId);
            captureRequest.requestBody({});

            const response = await this.paypal.execute(captureRequest);
            const capture = response.result;

            if (capture.status === 'COMPLETED') {
                const captureDetail = capture.purchase_units[0].payments.captures[0];
                await this.processPaypalPayment(payment, capture, captureDetail);
                return {
                    status: 200,
                    message: 'PayPal payment completed',
                    captureId: captureDetail.id,
                };
            } else {
                throw new BadRequestException(`Capture failed with status: ${capture.status}`);
            }

        } catch (error) {
            console.error('PayPal capture error:', error);
            throw new BadRequestException(
                `Failed to capture payment: ${error.message || 'Unknown error'}`
            );
        }
    }

    private async processPaypalPayment(
        payment: any,
        order: any,
        captureOrAuth: any
    ) {
        const booking = await this.bookingModel
            .findById(payment.bookingId)
            .populate('eventId', 'title location startDate endDate')
            .populate('zoneId', 'name')
            .populate('areaId', 'name');

        if (!booking) {
            throw new BadRequestException('Associated booking not found');
        }

        if (booking.paymentStatus === 'paid') {
            console.log(`Booking ${booking.bookingCode} already paid, skipping...`);
            return;
        }

        booking.paymentStatus = 'paid';
        booking.status = 'confirmed';
        booking.paidAt = new Date();

        if (booking.quantity > 0) {
            await this.zoneModel.findByIdAndUpdate(
                booking.zoneId,
                { $inc: { confirmedSoldCount: booking.quantity } }
            );
        }

        await booking.save();

        await this.paymentModel.findByIdAndUpdate(payment._id, {
            status: 'succeeded',
            paidAt: new Date(),
            metadata: {
                ...payment.metadata,
                orderId: order.id,
                orderStatus: order.status,
                authorizationId: captureOrAuth.id,
                captureStatus: captureOrAuth.status,
                capturedAt: new Date().toISOString()
            }
        });

        const tickets = await this.ticketService.createTicketsFromBooking(
            booking.bookingCode
        );

        const ticketMailData = tickets.map(ticket => ({
            ticketCode: ticket.ticketCode,
            seatNumber: ticket.seatNumber,
            qrCode: ticket.qrCode || '',
        }));

        try {
            await this.mailService.sendBookingConfirmation({
                email: booking.customerEmail,
                customerName: booking.customerName || 'Khách hàng',
                bookingCode: booking.bookingCode,
                eventTitle: (booking.eventId as any).title,
                eventLocation: (booking.eventId as any).location,
                eventDate: (booking.eventId as any).startDate,
                zoneName: (booking.zoneId as any).name,
                seats: booking.seats || [],
                quantity: booking.quantity,
                totalPrice: booking.totalPrice,
                currency: payment.currency,
                tickets: ticketMailData,
            });

            console.log('Confirmation email sent successfully');
        } catch (emailError) {
            console.error('Failed to send confirmation email:', emailError);
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