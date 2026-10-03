import AIStatusKit
import SwiftUI

/// Applies the daemon's `dismissPolicy`: `.swipe` clears immediately, `.confirm`
/// asks first. Attach once per screen; call `request(_:)` from any clear gesture.
struct ClearConfirmation: ViewModifier {
    @ObservedObject var model: StatusModel
    @Binding var target: CardPresentation?
    var onCleared: () -> Void = {}

    func body(content: Content) -> some View {
        content.confirmationDialog(
            target.map { "Clear \($0.project)?" } ?? "Clear?",
            isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }),
            titleVisibility: .visible,
            presenting: target
        ) { p in
            Button("Clear", role: .destructive) {
                target = nil
                clear(model: model, id: p.id)
                onCleared()
            }
            Button("Cancel", role: .cancel) { target = nil }
        } message: { p in
            Text([p.headline, p.detail].compactMap { $0 }.joined(separator: " · "))
        }
    }
}

@MainActor
func clear(model: StatusModel, id: String) {
    Task { await model.dismiss(id: id) }
}

@MainActor
func requestClear(_ p: CardPresentation, model: StatusModel, confirm: inout CardPresentation?) -> Bool {
    if p.dismissPolicy == .swipe {
        clear(model: model, id: p.id)
        return true
    }
    confirm = p
    return false
}

/// Exactly one session: a single large card filling the screen. Swipe it left
/// (or use the button) to clear.
struct SingleSessionView: View {
    @ObservedObject var model: StatusModel
    let p: CardPresentation
    @State private var confirm: CardPresentation?
    @State private var dragX: CGFloat = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                SessionCardView(p, size: .large)
                    .padding(10)
                    .background(CardBackground(tone: p.tone))
                    .offset(x: dragX)
                    .opacity(1 - Double(min(abs(dragX), 120)) / 200)
                    .gesture(
                        DragGesture(minimumDistance: 15)
                            .onChanged { v in
                                if abs(v.translation.width) > abs(v.translation.height) { dragX = min(0, v.translation.width) }
                            }
                            .onEnded { v in
                                if v.translation.width < -60, abs(v.translation.width) > abs(v.translation.height) {
                                    let cleared = requestClear(p, model: model, confirm: &confirm)
                                    withAnimation(.easeOut(duration: 0.2)) { dragX = cleared ? -300 : 0 }
                                } else {
                                    withAnimation(.spring()) { dragX = 0 }
                                }
                            }
                    )
                ClearButton(p: p) { _ = requestClear(p, model: model, confirm: &confirm) }
            }
        }
        .modifier(ClearConfirmation(model: model, target: $confirm))
        .onChange(of: p.id) { _, _ in dragX = 0 }
    }
}

struct ClearButton: View {
    let p: CardPresentation
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(p.dismissPolicy == .swipe ? "Clear" : "Clear…", systemImage: "xmark.circle")
                .frame(maxWidth: .infinity)
        }
        .tint(p.tone == .done || p.tone == .failed ? .accentColor : .gray)
        .accessibilityHint(p.dismissPolicy == .swipe ? "Clears immediately" : "Asks for confirmation")
    }
}

/// Several sessions: one card per row. Swipe left on a row to clear
/// (full swipe clears `.swipe` cards directly; `.confirm` cards show a dialog).
/// Tap a row for the large card.
struct SessionListView: View {
    @ObservedObject var model: StatusModel
    let items: [CardPresentation]
    @State private var confirm: CardPresentation?

    var body: some View {
        List {
            ForEach(items) { p in
                NavigationLink(value: p.id) {
                    SessionCardView(p, size: .compact)
                        .padding(.vertical, 4)
                }
                .listRowBackground(CardBackground(tone: p.tone))
                .swipeActions(edge: .trailing, allowsFullSwipe: p.dismissPolicy == .swipe) {
                    Button(role: p.dismissPolicy == .swipe ? .destructive : nil) {
                        _ = requestClear(p, model: model, confirm: &confirm)
                    } label: {
                        Label("Clear", systemImage: "xmark")
                    }
                    .tint(p.dismissPolicy == .swipe ? .red : .orange)
                }
            }
        }
        .modifier(ClearConfirmation(model: model, target: $confirm))
    }
}

/// Large card pushed from the list. Pops itself once the card is gone.
struct SessionDetailView: View {
    @ObservedObject var model: StatusModel
    let id: String
    @Environment(\.dismiss) private var dismiss
    @State private var confirm: CardPresentation?

    var body: some View {
        Group {
            if let p = model.presentations.first(where: { $0.id == id }) {
                ScrollView {
                    VStack(spacing: 8) {
                        SessionCardView(p, size: .large)
                            .padding(10)
                            .background(CardBackground(tone: p.tone))
                        ClearButton(p: p) {
                            if requestClear(p, model: model, confirm: &confirm) { dismiss() }
                        }
                    }
                }
            } else {
                Text("Cleared").foregroundStyle(.secondary)
                    .onAppear { dismiss() }
            }
        }
        .modifier(ClearConfirmation(model: model, target: $confirm, onCleared: { dismiss() }))
    }
}
