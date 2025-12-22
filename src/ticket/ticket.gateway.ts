// ticket.gateway.ts
import {
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';
import { Server } from 'socket.io';


interface TicketCreatedPayload {
    bookingCode: string;
    tickets: Array<{
        ticketCode: string;
        eventId: string;
        zoneId: string;
        seatNumber: string | null;
        price: number;
        status: string;
    }>;
}



interface TicketCheckinPayload {
    ticketCode: string;
    eventId: string;
    zoneId: string;
    seatNumber: string | null;
    checkedInAt: Date;
};



@WebSocketGateway({
    cors: { origin: '*' },
    namespace: '/ticket',
})
export class TicketGateway {
    @WebSocketServer()
    server: Server;

    emitTicketCreated(data: TicketCreatedPayload) {
        const eventId = data.tickets[0]?.eventId;
        if (!eventId) return;
        this.server
            .to(`event:${eventId}`)
            .emit('ticket.created', data);
    }

    emitTicketCheckedIn(data: TicketCheckinPayload) {
        this.server
            .to(`event:${data.eventId}`)
            .emit('ticket.checked_in', data);
        // chia room theo eventId de chi nhan thong bao checkin ve cho nhung client quan tam den event do
    }

    emitTicketCancelled(data: any) {
        this.server.emit('ticket.cancelled', data);
    }
}
