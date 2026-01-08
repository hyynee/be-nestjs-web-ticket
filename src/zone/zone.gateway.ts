
import {
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Logger } from '@nestjs/common';

interface ZoneTicketUpdatePayload {
    zoneId: string;
    eventId: string;
    capacity: number;
    soldCount: number;
    confirmedSoldCount: number;
    availableTickets: number;
}

@WebSocketGateway({
    cors: {
        origin: ["http://localhost:5173", "http://localhost:9000", "http://localhost:3000"],
    },
    namespace: '/zone',
})

export class ZoneGateway {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(ZoneGateway.name);

    emitZoneTicketUpdate(data: ZoneTicketUpdatePayload) {
        this.server
            .to(`event:${data.eventId}`)
            .emit('zone.ticket_update', data);
        // chia room theo eventId de chi nhan thong bao cap nhat ve zone cho nhung client quan tam den event do
    }
}